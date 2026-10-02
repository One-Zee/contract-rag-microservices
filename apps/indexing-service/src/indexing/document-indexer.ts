import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { type DocumentStatus, documentIndexedEvent } from '@app/common';
import {
  EMBEDDINGS,
  EmbeddingError,
  type EmbeddingProvider,
} from '@app/embeddings';
import { EventPublisher } from '@app/messaging';
import { getMeter, withSpan } from '@app/telemetry';
import type { Counter } from '@opentelemetry/api';
import { ChunksRepository } from './chunks.repository.js';
import { DocumentsRepository } from './documents.repository.js';

/** States a document may be picked up in; `indexing` is a previous run a crash cut short. */
const INDEXABLE: ReadonlySet<DocumentStatus> = new Set(['chunked', 'indexing']);

const ERROR_MESSAGE_MAX = 500;

export type IndexOutcome =
  /** Every chunk has its vector; `document.indexed` was published (or at least attempted). */
  | { kind: 'indexed'; chunkCount: number }
  /** Nothing to do: the document is gone, already done, in another state, or being handled right now. */
  | { kind: 'skipped'; reason: string }
  /** Recorded on the document as `failed` — retrying would fail the same way. */
  | { kind: 'failed'; reason: string }
  /** Could not finish for now (provider outage, database hiccup); the document is back to `chunked`. */
  | { kind: 'deferred'; reason: string };

export class NoChunksError extends Error {
  constructor() {
    super('No chunks to index — the document was chunked to nothing');
    this.name = 'NoChunksError';
  }
}

const describeError = (error: unknown): string => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, ERROR_MESSAGE_MAX);
};

let embeddedChunks: Counter | undefined;

/**
 * Chunks that received a vector — with the depth of the `indexing` queue, how
 * a dashboard shows whether indexing keeps up. Created on first use,
 * after the SDK has started, never at import.
 */
const embeddedChunksCounter = (): Counter =>
  (embeddedChunks ??= getMeter().createCounter('clauseiq.indexing.chunks', {
    description: 'Chunks that received a vector',
  }));

const isPermanent = (error: unknown): boolean =>
  error instanceof NoChunksError ||
  (error instanceof EmbeddingError && !error.retryable);

/**
 * One document, start to finish: chunks without a vector → provider →
 * `UPDATE chunks SET embedding` → `document.indexed`.
 *
 *   chunked ─► indexing ─► indexed
 *                 │
 *                 ├─► failed   (a non-retryable provider answer, or no chunks)
 *                 └─► chunked  (deferred: the provider or the database gave
 *                               up for now; a boot sweep or a replayed event
 *                               picks it up again)
 *
 * The database is the source of truth and the event only a trigger: only
 * chunks whose embedding is NULL are sent to the provider, so a redelivered
 * event, a boot sweep and a second instance all converge on the same rows
 * without duplicating work that was already written.
 */
@Injectable()
export class DocumentIndexer implements OnApplicationShutdown {
  private readonly logger = new Logger(DocumentIndexer.name);
  private readonly inFlight = new Map<string, Promise<IndexOutcome>>();
  private readonly batchSize: number;

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly chunks: ChunksRepository,
    @Inject(EMBEDDINGS) private readonly provider: EmbeddingProvider,
    private readonly publisher: EventPublisher,
    config: AppConfigService,
  ) {
    this.batchSize = config.embeddingBatchSize;
  }

  /** Never rejects for a reason the document can record; a database that is down does propagate. */
  index(documentId: string): Promise<IndexOutcome> {
    if (this.inFlight.has(documentId)) {
      // The boot sweep and the consumer can meet on the same document; the
      // run already going will finish it.
      return Promise.resolve(
        this.skip(documentId, 'already being indexed by this process'),
      );
    }
    // A span of its own, for the same reason as ingestion's: the boot sweep
    // indexes documents outside any consumed message.
    const run = withSpan(
      'indexing.document',
      { 'clauseiq.document.id': documentId },
      async (span) => {
        const outcome = await this.run(documentId);
        span.setAttribute('clauseiq.indexing.outcome', outcome.kind);
        return outcome;
      },
    ).finally(() => this.inFlight.delete(documentId));
    this.inFlight.set(documentId, run);
    return run;
  }

  /** How many documents this process is embedding right now. */
  get activeCount(): number {
    return this.inFlight.size;
  }

  /**
   * Lets running documents finish their batch; whatever is not done is in
   * `indexing` and the next boot's sweep continues from the first NULL
   * embedding. Docker's default grace period is 10 s, so this is a courtesy.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight.size > 0) {
      this.logger.log(
        `Waiting for ${this.inFlight.size} document(s) in flight`,
      );
      await Promise.allSettled(this.inFlight.values());
    }
  }

  private async run(documentId: string): Promise<IndexOutcome> {
    const document = await this.documents.findById(documentId);
    if (!document) {
      return this.skip(documentId, 'document no longer exists');
    }
    if (!INDEXABLE.has(document.status)) {
      return this.skip(documentId, `document is ${document.status}`);
    }

    await this.documents.setStatus(documentId, {
      status: 'indexing',
      errorMessage: null,
    });
    const startedAt = Date.now();
    let batches = 0;
    let embedded = 0;
    let tokens = 0;

    try {
      for (;;) {
        const batch = await this.chunks.findUnembedded(
          documentId,
          this.batchSize,
        );
        if (batch.length === 0) {
          break;
        }
        const totalTokens = await withSpan(
          'indexing.batch',
          {
            'clauseiq.indexing.batch_size': batch.length,
            'clauseiq.embedding.provider': this.provider.name,
          },
          async () => {
            const result = await this.provider.embed(
              batch.map((chunk) => chunk.content),
              'document',
            );
            await this.chunks.setEmbeddings(
              batch.map((chunk, i) => ({
                id: chunk.id,
                embedding: result.vectors[i],
              })),
            );
            return result.totalTokens;
          },
        );
        embeddedChunksCounter().add(batch.length, {
          'clauseiq.embedding.provider': this.provider.name,
        });
        batches += 1;
        embedded += batch.length;
        tokens += totalTokens ?? 0;
      }

      const chunkCount = await this.chunks.countForDocument(documentId);
      if (chunkCount === 0) {
        throw new NoChunksError();
      }
      await this.documents.setStatus(documentId, {
        status: 'indexed',
        errorMessage: null,
      });
      this.logger.log(
        `Document ${documentId} indexed: ${chunkCount} chunks (${embedded} embedded in ${batches} batches, ${tokens} ${this.provider.name} tokens), ${Date.now() - startedAt} ms`,
      );

      await this.announce(documentId, document.uploadedBy, chunkCount);
      return { kind: 'indexed', chunkCount };
    } catch (error) {
      const reason = describeError(error);
      if (isPermanent(error)) {
        await this.documents.setStatus(documentId, {
          status: 'failed',
          errorMessage: reason,
        });
        this.logger.error(`Document ${documentId} failed: ${reason}`);
        return { kind: 'failed', reason };
      }
      // Back to where the event found it, with the reason on the row so the
      // polling client sees why nothing is happening. If even this write
      // fails the error propagates, the row stays `indexing`, and the boot
      // sweep covers it.
      await this.documents.setStatus(documentId, {
        status: 'chunked',
        errorMessage: reason,
      });
      this.logger.warn(`Document ${documentId} deferred: ${reason}`);
      return { kind: 'deferred', reason };
    }
  }

  /**
   * After `indexed`, and never fatal: the document *is* searchable, and a
   * lost `document.indexed` costs nothing while nothing consumes it. This is
   * the mirror image of ingestion, where a lost `document.chunked` would
   * mean no embeddings ever — so there the failure is recorded.
   */
  private async announce(
    documentId: string,
    uploadedBy: string,
    chunkCount: number,
  ): Promise<void> {
    try {
      await this.publisher.publish(
        documentIndexedEvent({ documentId, uploadedBy, chunkCount }),
      );
    } catch (error) {
      this.logger.error(
        `Document ${documentId} is indexed but document.indexed was not published: ${describeError(error)}`,
      );
    }
  }

  private skip(documentId: string, reason: string): IndexOutcome {
    this.logger.debug(`Document ${documentId} skipped: ${reason}`);
    return { kind: 'skipped', reason };
  }
}
