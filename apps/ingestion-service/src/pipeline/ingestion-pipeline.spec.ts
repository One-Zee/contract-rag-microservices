import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { DOCUMENT_EVENTS } from '@app/common';
import type { EventPublisher } from '@app/messaging';
import type { ChunksRepository } from '../documents/chunks.repository.js';
import type {
  DocumentRecord,
  DocumentsRepository,
} from '../documents/documents.repository.js';
import type { TextExtractionService } from '../extraction/text-extractor.js';
import type { StorageService } from '../storage/storage.service.js';
import { IngestionPipeline } from './ingestion-pipeline.js';

Logger.overrideLogger(false);

const aDocument = (
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord => ({
  id: 'doc-1',
  title: 'MSA',
  originalFilename: 'msa.pdf',
  storageKey: 'documents/doc-1/original.pdf',
  mimeType: 'application/pdf',
  fileSize: 3,
  status: 'uploaded',
  visibility: 'private',
  pageCount: null,
  errorMessage: null,
  uploadedBy: 'u-1',
  createdAt: new Date('2026-09-14T00:00:00Z'),
  updatedAt: new Date('2026-09-14T00:00:00Z'),
  ...overrides,
});

const twoPages = {
  pages: [
    {
      number: 1,
      text: 'ARTICLE 1\nThe first article states the first obligation.',
    },
    {
      number: 2,
      text: 'ARTICLE 2\nThe second article states the second obligation.',
    },
  ],
  text: '',
};

/** `null` stands for "no such row" — `undefined` would just select the default. */
const setup = (document: DocumentRecord | null = aDocument()) => {
  const documents = {
    findById: vi.fn().mockResolvedValue(document ?? undefined),
    update: vi.fn().mockResolvedValue(document ?? undefined),
  };
  const chunks = {
    replaceForDocument: vi.fn(
      async (_id: string, rows: unknown[]) => rows.length,
    ),
  };
  const storage = { get: vi.fn().mockResolvedValue(Buffer.from('pdf')) };
  const extraction = { extract: vi.fn().mockResolvedValue(twoPages) };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const config = {
    chunkSizeTokens: 800,
    chunkOverlapTokens: 120,
  } as AppConfigService;
  const pipeline = new IngestionPipeline(
    documents as unknown as DocumentsRepository,
    chunks as unknown as ChunksRepository,
    storage as unknown as StorageService,
    extraction as unknown as TextExtractionService,
    publisher as unknown as EventPublisher,
    config,
  );
  return { pipeline, documents, chunks, storage, extraction, publisher };
};

const statusUpdates = (documents: { update: ReturnType<typeof vi.fn> }) =>
  documents.update.mock.calls.map(([, patch]) => patch.status);

describe('IngestionPipeline', () => {
  it('takes a document from uploaded through parsing to chunked and announces it', async () => {
    const { pipeline, documents, chunks, storage, publisher } = setup();

    await pipeline.process('doc-1');

    expect(storage.get).toHaveBeenCalledWith('documents/doc-1/original.pdf');
    expect(statusUpdates(documents)).toEqual(['parsing', 'chunked']);
    expect(documents.update).toHaveBeenLastCalledWith('doc-1', {
      status: 'chunked',
      pageCount: 2,
    });

    const [, rows] = chunks.replaceForDocument.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      chunkIndex: 0,
      pageNumber: 1,
      sectionTitle: 'ARTICLE 1',
    });
    expect(rows[1]).toMatchObject({
      chunkIndex: 1,
      pageNumber: 2,
      sectionTitle: 'ARTICLE 2',
    });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish.mock.calls[0][0]).toMatchObject({
      type: DOCUMENT_EVENTS.CHUNKED,
      documentId: 'doc-1',
      uploadedBy: 'u-1',
      chunkCount: 2,
    });
    expect(publisher.publish.mock.calls[0][0].eventId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('reports no page count for a format without pages', async () => {
    const { pipeline, documents, extraction } = setup();
    extraction.extract.mockResolvedValue({ pages: null, text: 'Some clause.' });

    await pipeline.process('doc-1');

    expect(documents.update).toHaveBeenLastCalledWith('doc-1', {
      status: 'chunked',
      pageCount: null,
    });
  });

  it('marks the document failed when extraction throws, without touching chunks or the broker', async () => {
    const { pipeline, documents, chunks, extraction, publisher } = setup();
    extraction.extract.mockRejectedValue(new Error('Invalid PDF structure'));

    await pipeline.process('doc-1');

    expect(statusUpdates(documents)).toEqual(['parsing', 'failed']);
    expect(documents.update).toHaveBeenLastCalledWith('doc-1', {
      status: 'failed',
      errorMessage: 'Error: Invalid PDF structure',
    });
    expect(chunks.replaceForDocument).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('fails a document that yields no text — a scan without a text layer', async () => {
    const { pipeline, documents, chunks, extraction } = setup();
    extraction.extract.mockResolvedValue({
      pages: [{ number: 1, text: '\n\n' }],
      text: '',
    });

    await pipeline.process('doc-1');

    expect(documents.update).toHaveBeenLastCalledWith('doc-1', {
      status: 'failed',
      errorMessage: expect.stringContaining('No extractable text'),
    });
    expect(chunks.replaceForDocument).not.toHaveBeenCalled();
  });

  it('fails the document when the broker refuses the event, after the chunks were written', async () => {
    const { pipeline, documents, chunks, publisher } = setup();
    publisher.publish.mockRejectedValue(new Error('channel closed'));

    await pipeline.process('doc-1');

    expect(chunks.replaceForDocument).toHaveBeenCalledTimes(1);
    expect(statusUpdates(documents)).toEqual(['parsing', 'chunked', 'failed']);
    expect(documents.update).toHaveBeenLastCalledWith('doc-1', {
      status: 'failed',
      errorMessage: 'Error: channel closed',
    });
  });

  it('truncates a long failure reason', async () => {
    const { pipeline, documents, storage } = setup();
    storage.get.mockRejectedValue(new Error('x'.repeat(2_000)));

    await pipeline.process('doc-1');

    const [, patch] = documents.update.mock.calls.at(-1)!;
    expect(patch.errorMessage.length).toBeLessThanOrEqual(500);
  });

  it.each(['chunked', 'indexing', 'indexed', 'failed'] as const)(
    'leaves a document that is already %s alone',
    async (status) => {
      const { pipeline, documents, storage } = setup(aDocument({ status }));

      await pipeline.process('doc-1');

      expect(documents.update).not.toHaveBeenCalled();
      expect(storage.get).not.toHaveBeenCalled();
    },
  );

  it('resumes a document a crash left in parsing', async () => {
    const { pipeline, documents } = setup(aDocument({ status: 'parsing' }));

    await pipeline.process('doc-1');

    expect(statusUpdates(documents)).toEqual(['parsing', 'chunked']);
  });

  it('does nothing for an id that no longer exists', async () => {
    const { pipeline, documents, storage } = setup(null);

    await pipeline.process('gone');

    expect(documents.update).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });
});
