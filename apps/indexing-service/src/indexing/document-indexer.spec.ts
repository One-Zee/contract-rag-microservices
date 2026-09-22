import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { DOCUMENT_EVENTS, type DocumentIndexedEvent } from '@app/common';
import { EmbeddingError, type EmbeddingProvider } from '@app/embeddings';
import type { EventPublisher } from '@app/messaging';
import type { ChunksRepository, UnembeddedChunk } from './chunks.repository.js';
import { DocumentIndexer } from './document-indexer.js';
import type {
  DocumentsRepository,
  IndexableDocument,
} from './documents.repository.js';

Logger.overrideLogger(false);

const DIMENSIONS = 4;
const BATCH_SIZE = 100;

const aDocument = (
  overrides: Partial<IndexableDocument> = {},
): IndexableDocument => ({
  id: 'doc-1',
  status: 'chunked',
  uploadedBy: 'u-1',
  ...overrides,
});

const someChunks = (count: number): UnembeddedChunk[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    content: `Clause ${i}`,
  }));

const vectorFor = (content: string): number[] =>
  Array.from({ length: DIMENSIONS }, (_, i) => content.length + i);

/**
 * An in-memory `chunks` table: `findUnembedded` hands out what still has no
 * vector, `setEmbeddings` fills it in — so the loop in the indexer is driven
 * by the same NULL-filter contract the real repository implements.
 */
const chunksTable = (rows: UnembeddedChunk[]) => {
  const embeddings = new Map<string, number[]>();
  const repository = {
    findUnembedded: vi.fn(async (_documentId: string, limit: number) =>
      rows.filter((row) => !embeddings.has(row.id)).slice(0, limit),
    ),
    setEmbeddings: vi.fn(
      async (updates: { id: string; embedding: number[] }[]) => {
        for (const { id, embedding } of updates) {
          embeddings.set(id, embedding);
        }
      },
    ),
    countForDocument: vi.fn(async () => rows.length),
  };
  return { repository, embeddings };
};

/** `null` stands for "no such row" — `undefined` would just select the default. */
const setup = (
  document: IndexableDocument | null = aDocument(),
  rows: UnembeddedChunk[] = someChunks(3),
) => {
  const documents = {
    findById: vi.fn().mockResolvedValue(document ?? undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
  const { repository: chunks, embeddings } = chunksTable(rows);
  const provider = {
    name: 'test',
    model: 'test-model',
    dimensions: DIMENSIONS,
    embed: vi.fn(async (texts: string[]) => ({
      vectors: texts.map(vectorFor),
      totalTokens: texts.length * 10,
    })),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const config = { embeddingBatchSize: BATCH_SIZE } as AppConfigService;
  const indexer = new DocumentIndexer(
    documents as unknown as DocumentsRepository,
    chunks as unknown as ChunksRepository,
    provider as unknown as EmbeddingProvider,
    publisher as unknown as EventPublisher,
    config,
  );
  return { indexer, documents, chunks, embeddings, provider, publisher };
};

const statusUpdates = (documents: { setStatus: ReturnType<typeof vi.fn> }) =>
  documents.setStatus.mock.calls.map(([, patch]) => patch.status);

describe('DocumentIndexer', () => {
  describe('happy path', () => {
    it('moves chunked → indexing → indexed and stores one vector per chunk', async () => {
      const { indexer, documents, embeddings, provider } = setup();

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({ kind: 'indexed', chunkCount: 3 });
      expect(statusUpdates(documents)).toEqual(['indexing', 'indexed']);
      expect(documents.setStatus).toHaveBeenLastCalledWith('doc-1', {
        status: 'indexed',
        errorMessage: null,
      });
      expect(provider.embed).toHaveBeenCalledWith(
        ['Clause 0', 'Clause 1', 'Clause 2'],
        'document',
      );
      expect([...embeddings.entries()]).toEqual([
        ['chunk-0', vectorFor('Clause 0')],
        ['chunk-1', vectorFor('Clause 1')],
        ['chunk-2', vectorFor('Clause 2')],
      ]);
    });

    it('publishes document.indexed exactly once, after the status, with the owner and the count', async () => {
      const { indexer, documents, publisher } = setup();

      await indexer.index('doc-1');

      expect(publisher.publish).toHaveBeenCalledTimes(1);
      const [event] = publisher.publish.mock.calls[0] as [DocumentIndexedEvent];
      expect(event).toMatchObject({
        type: DOCUMENT_EVENTS.INDEXED,
        documentId: 'doc-1',
        uploadedBy: 'u-1',
        chunkCount: 3,
      });
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(publisher.publish.mock.invocationCallOrder[0]).toBeGreaterThan(
        documents.setStatus.mock.invocationCallOrder[1],
      );
    });

    it('embeds in batches of EMBEDDING_BATCH_SIZE, in chunk order, until nothing is left', async () => {
      const { indexer, provider, chunks } = setup(aDocument(), someChunks(250));

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({ kind: 'indexed', chunkCount: 250 });
      expect(provider.embed).toHaveBeenCalledTimes(3);
      const sizes = provider.embed.mock.calls.map(([texts]) => texts.length);
      expect(sizes).toEqual([100, 100, 50]);
      expect(provider.embed.mock.calls[1][0][0]).toBe('Clause 100');
      expect(chunks.setEmbeddings).toHaveBeenCalledTimes(3);
    });

    it('only sends chunks whose embedding is still NULL — a re-run continues, it does not redo', async () => {
      const { indexer, provider, embeddings } = setup(
        aDocument({ status: 'indexing' }),
        someChunks(5),
      );
      // a previous run, cut short after the first two
      embeddings.set('chunk-0', vectorFor('Clause 0'));
      embeddings.set('chunk-1', vectorFor('Clause 1'));

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({ kind: 'indexed', chunkCount: 5 });
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(provider.embed).toHaveBeenCalledWith(
        ['Clause 2', 'Clause 3', 'Clause 4'],
        'document',
      );
    });

    it('reports indexed even when the vectors were all there already', async () => {
      const { indexer, provider, embeddings, publisher } = setup();
      for (const chunk of someChunks(3)) {
        embeddings.set(chunk.id, vectorFor(chunk.content));
      }

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({ kind: 'indexed', chunkCount: 3 });
      expect(provider.embed).not.toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('skips', () => {
    it('skips a document that no longer exists — deleted behind its event — without touching anything', async () => {
      const { indexer, documents, provider, publisher } = setup(null);

      const outcome = await indexer.index('doc-gone');

      expect(outcome).toMatchObject({ kind: 'skipped' });
      expect(documents.setStatus).not.toHaveBeenCalled();
      expect(provider.embed).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it.each(['indexed', 'failed', 'uploaded', 'parsing'] as const)(
      'skips a document that is %s — a redelivered or stale event',
      async (status) => {
        const { indexer, documents, provider, publisher } = setup(
          aDocument({ status }),
        );

        const outcome = await indexer.index('doc-1');

        expect(outcome).toEqual({
          kind: 'skipped',
          reason: `document is ${status}`,
        });
        expect(documents.setStatus).not.toHaveBeenCalled();
        expect(provider.embed).not.toHaveBeenCalled();
        expect(publisher.publish).not.toHaveBeenCalled();
      },
    );

    it('skips a document this process is already indexing, and lets the first run finish it', async () => {
      const { indexer, provider, publisher } = setup();
      let release!: () => void;
      provider.embed.mockImplementationOnce(
        (texts: string[]) =>
          new Promise((resolve) => {
            release = () =>
              resolve({ vectors: texts.map(vectorFor), totalTokens: 0 });
          }),
      );

      const first = indexer.index('doc-1');
      await vi.waitFor(() => expect(provider.embed).toHaveBeenCalledTimes(1));
      const second = await indexer.index('doc-1');
      expect(indexer.activeCount).toBe(1);

      release();
      await expect(first).resolves.toEqual({ kind: 'indexed', chunkCount: 3 });
      expect(second).toMatchObject({ kind: 'skipped' });
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(publisher.publish).toHaveBeenCalledTimes(1);
      expect(indexer.activeCount).toBe(0);
    });
  });

  describe('failures', () => {
    it('marks the document failed on a non-retryable provider error, keeping the batches already written', async () => {
      const { indexer, documents, provider, embeddings, publisher } = setup(
        aDocument(),
        someChunks(150),
      );
      provider.embed
        .mockImplementationOnce(async (texts: string[]) => ({
          vectors: texts.map(vectorFor),
          totalTokens: 0,
        }))
        .mockRejectedValueOnce(
          new EmbeddingError('Voyage responded 400: bad input', {
            retryable: false,
            status: 400,
          }),
        );

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({
        kind: 'failed',
        reason: 'EmbeddingError: Voyage responded 400: bad input',
      });
      expect(statusUpdates(documents)).toEqual(['indexing', 'failed']);
      expect(documents.setStatus).toHaveBeenLastCalledWith('doc-1', {
        status: 'failed',
        errorMessage: 'EmbeddingError: Voyage responded 400: bad input',
      });
      expect(embeddings.size).toBe(100);
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('marks a document with no chunks failed rather than indexed', async () => {
      const { indexer, documents, publisher } = setup(aDocument(), []);

      const outcome = await indexer.index('doc-1');

      expect(outcome).toMatchObject({ kind: 'failed' });
      expect(documents.setStatus).toHaveBeenLastCalledWith('doc-1', {
        status: 'failed',
        errorMessage: expect.stringContaining('No chunks to index'),
      });
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('defers on a retryable provider error: back to chunked with the reason, nothing published', async () => {
      const { indexer, documents, provider, publisher } = setup();
      provider.embed.mockRejectedValueOnce(
        new EmbeddingError('Voyage responded 503: down', {
          retryable: true,
          status: 503,
        }),
      );

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({
        kind: 'deferred',
        reason: 'EmbeddingError: Voyage responded 503: down',
      });
      expect(statusUpdates(documents)).toEqual(['indexing', 'chunked']);
      expect(documents.setStatus).toHaveBeenLastCalledWith('doc-1', {
        status: 'chunked',
        errorMessage: 'EmbeddingError: Voyage responded 503: down',
      });
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('defers on an unclassified error too — a database hiccup is not the document’s fault', async () => {
      const { indexer, documents, chunks } = setup();
      chunks.setEmbeddings.mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({
        kind: 'deferred',
        reason: 'Error: connection terminated unexpectedly',
      });
      expect(statusUpdates(documents)).toEqual(['indexing', 'chunked']);
    });

    it('propagates when even the status cannot be written — the message must not be acked', async () => {
      const { indexer, documents, provider } = setup();
      provider.embed.mockRejectedValueOnce(new Error('boom'));
      documents.setStatus
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('database is down'));

      await expect(indexer.index('doc-1')).rejects.toThrow('database is down');
      expect(indexer.activeCount).toBe(0);
    });

    it('truncates the recorded reason to 500 characters', async () => {
      const { indexer, documents, provider } = setup();
      provider.embed.mockRejectedValueOnce(
        new EmbeddingError('x'.repeat(2_000), { retryable: false }),
      );

      await indexer.index('doc-1');

      const [, patch] = documents.setStatus.mock.calls.at(-1)!;
      expect(patch.errorMessage).toHaveLength(500);
    });

    it('keeps the document indexed when only the announcement fails', async () => {
      const { indexer, documents, publisher } = setup();
      publisher.publish.mockRejectedValueOnce(new Error('channel closed'));

      const outcome = await indexer.index('doc-1');

      expect(outcome).toEqual({ kind: 'indexed', chunkCount: 3 });
      expect(statusUpdates(documents)).toEqual(['indexing', 'indexed']);
    });
  });

  describe('shutdown', () => {
    it('waits for the documents in flight', async () => {
      const { indexer, provider } = setup();
      let release!: () => void;
      provider.embed.mockImplementationOnce(
        (texts: string[]) =>
          new Promise((resolve) => {
            release = () =>
              resolve({ vectors: texts.map(vectorFor), totalTokens: 0 });
          }),
      );
      const run = indexer.index('doc-1');
      await vi.waitFor(() => expect(provider.embed).toHaveBeenCalledTimes(1));

      let finished = false;
      const shutdown = indexer.onApplicationShutdown().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);

      release();
      await shutdown;
      expect(finished).toBe(true);
      await expect(run).resolves.toMatchObject({ kind: 'indexed' });
    });

    it('returns at once when nothing is in flight', async () => {
      const { indexer } = setup();

      await expect(indexer.onApplicationShutdown()).resolves.toBeUndefined();
    });
  });
});
