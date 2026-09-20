import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { DocumentsRepository } from '../documents/documents.repository.js';
import { IngestionPipeline } from './ingestion-pipeline.js';

/**
 * In-process work queue with bounded concurrency. The upload handler replies
 * as soon as the row exists and hands the id here; parsing then runs in the
 * background of the same process, never more than `INGESTION_CONCURRENCY`
 * documents at a time (pdf.js is CPU-bound and shares the event loop with the
 * TCP handlers).
 *
 * Durability is the database's: a document a crash left in `uploaded` or
 * `parsing` is re-queued at the next boot. That assumes a single instance —
 * two would both pick it up (harmless thanks to the unique chunk index, but
 * wasted). A broker-backed queue is the step beyond this.
 */
@Injectable()
export class ProcessingQueue
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ProcessingQueue.name);
  private readonly pending: string[] = [];
  private readonly known = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly concurrency: number;

  constructor(
    private readonly pipeline: IngestionPipeline,
    private readonly documents: DocumentsRepository,
    config: AppConfigService,
  ) {
    this.concurrency = config.ingestionConcurrency;
  }

  /** Idempotent: an id already waiting or running is not queued twice. */
  enqueue(documentId: string): void {
    if (this.known.has(documentId)) {
      return;
    }
    this.known.add(documentId);
    this.pending.push(documentId);
    this.drain();
  }

  /** Waiting plus running. */
  get size(): number {
    return this.pending.length + this.inFlight.size;
  }

  async onApplicationBootstrap(): Promise<void> {
    const unfinished = await this.documents.findIdsByStatus([
      'uploaded',
      'parsing',
    ]);
    if (unfinished.length > 0) {
      this.logger.warn(
        `Re-queuing ${unfinished.length} document(s) left unfinished by a previous run`,
      );
      for (const id of unfinished) {
        this.enqueue(id);
      }
    }
  }

  /**
   * Lets running documents finish. Docker's default grace period is 10 s
   * a document that needs longer is re-queued at the next boot
   * anyway, so waiting here is a courtesy, not a guarantee.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight.size > 0) {
      this.logger.log(
        `Waiting for ${this.inFlight.size} document(s) in flight`,
      );
      await Promise.allSettled(this.inFlight);
    }
  }

  private drain(): void {
    while (this.inFlight.size < this.concurrency && this.pending.length > 0) {
      const documentId = this.pending.shift()!;
      const run: Promise<void> = this.pipeline
        .process(documentId)
        .catch((error: unknown) => {
          // The pipeline reports its own failures; this is the safety net.
          this.logger.error(
            `Unhandled error processing ${documentId}: ${String(error)}`,
          );
        })
        .finally(() => {
          this.inFlight.delete(run);
          this.known.delete(documentId);
          this.drain();
        });
      this.inFlight.add(run);
    }
  }
}
