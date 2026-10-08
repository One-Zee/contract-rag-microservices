import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { type DocumentStatus, documentChunkedEvent } from '@app/common';
import { EventPublisher } from '@app/messaging';
import { withSpan } from '@app/telemetry';
import { chunkText } from '../chunking/chunker.js';
import { assembleDocumentText } from '../chunking/document-text.js';
import { ChunksRepository } from '../documents/chunks.repository.js';
import { DocumentsRepository } from '../documents/documents.repository.js';
import { TextExtractionService } from '../extraction/text-extractor.js';
import { StorageService } from '../storage/storage.service.js';

/** States a document may be picked up in; anything else is done or someone else's. */
const PROCESSABLE: ReadonlySet<DocumentStatus> = new Set([
  'uploaded',
  'parsing',
]);

const ERROR_MESSAGE_MAX = 500;

export class NoExtractableTextError extends Error {
  constructor() {
    super('No extractable text — a scanned document needs OCR first');
    this.name = 'NoExtractableTextError';
  }
}

const describeError = (error: unknown): string => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, ERROR_MESSAGE_MAX);
};

/**
 * One document, start to finish: storage → text → chunks → `document.chunked`.
 *
 *   uploaded ─► parsing ─► chunked ─► (indexing-service takes over)
 *                  │
 *                  └─► failed  (with `error_message`; a new upload starts over)
 *
 * The file is always read back from storage rather than handed over from the
 * upload, so the first run, a re-run and a crash recovery are one code path.
 * Any error — unreadable file, encrypted PDF, no text layer, broker down —
 * ends in `failed` with the reason; nothing is thrown past this class.
 */
@Injectable()
export class IngestionPipeline {
  private readonly logger = new Logger(IngestionPipeline.name);

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly chunks: ChunksRepository,
    private readonly storage: StorageService,
    private readonly extraction: TextExtractionService,
    private readonly publisher: EventPublisher,
    private readonly config: AppConfigService,
  ) {}

  /**
   * A span of its own: an upload's run continues the request's trace, but the
   * queue also re-runs documents at boot, outside any request — and without a
   * parent their queries would not be traced at all.
   */
  process(documentId: string): Promise<void> {
    return withSpan(
      'ingestion.document',
      { 'clauseiq.document.id': documentId },
      () => this.run(documentId),
    );
  }

  private async run(documentId: string): Promise<void> {
    const document = await this.documents.findById(documentId);
    if (!document) {
      this.logger.warn(`Document ${documentId} vanished before processing`);
      return;
    }
    if (!PROCESSABLE.has(document.status)) {
      this.logger.debug(
        `Document ${documentId} is ${document.status}, nothing to do`,
      );
      return;
    }

    await this.documents.update(documentId, {
      status: 'parsing',
      errorMessage: null,
    });
    const startedAt = Date.now();

    try {
      const bytes = await this.storage.get(document.storageKey);
      // Extraction and chunking are CPU and nothing else — no query, no
      // request — so without these two spans they would be a gap between the
      // S3 read and the INSERT.
      const extracted = await withSpan(
        'ingestion.extract',
        {
          'clauseiq.document.mime_type': document.mimeType,
          'clauseiq.document.bytes': bytes.length,
        },
        () => this.extraction.extract(bytes, document.mimeType),
      );
      const drafts = await withSpan('ingestion.chunk', {}, (span) => {
        const { text, pages } = assembleDocumentText(extracted);
        const result = chunkText(text, {
          chunkSize: this.config.chunkSizeTokens,
          chunkOverlap: this.config.chunkOverlapTokens,
          respectSections: this.config.chunkRespectSections,
          pages,
        });
        span.setAttribute('clauseiq.document.chunks', result.length);
        return result;
      });
      if (drafts.length === 0) {
        throw new NoExtractableTextError();
      }

      const chunkCount = await this.chunks.replaceForDocument(
        documentId,
        drafts.map(
          ({ index, content, pageNumber, sectionTitle, tokenCount }) => ({
            chunkIndex: index,
            content,
            pageNumber,
            sectionTitle,
            tokenCount,
          }),
        ),
      );
      await this.documents.update(documentId, {
        status: 'chunked',
        pageCount: extracted.pages?.length ?? null,
      });

      // After `chunked`, not before: the event announces chunks that exist.
      // If the broker refuses it the document is marked failed below — the
      // honest answer without a transactional outbox (ADR 008).
      await this.publisher.publish(
        documentChunkedEvent({
          documentId,
          uploadedBy: document.uploadedBy,
          chunkCount,
        }),
      );

      this.logger.log(
        `Document ${documentId} chunked: ${chunkCount} chunks, ${extracted.pages?.length ?? '?'} pages, ${Date.now() - startedAt} ms`,
      );
    } catch (error) {
      const reason = describeError(error);
      await this.documents.update(documentId, {
        status: 'failed',
        errorMessage: reason,
      });
      this.logger.error(`Document ${documentId} failed: ${reason}`);
    }
  }
}
