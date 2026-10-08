import { Logger } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { DOCUMENT_EVENTS, type DocumentChunkedEvent } from '@app/common';
import type { DocumentIndexer, IndexOutcome } from './document-indexer.js';
import { IndexingController } from './indexing.controller.js';

Logger.overrideLogger(false);

const anEvent = (
  overrides: Partial<DocumentChunkedEvent> = {},
): DocumentChunkedEvent => ({
  eventId: 'evt-1',
  type: DOCUMENT_EVENTS.CHUNKED,
  occurredAt: '2026-09-20T10:00:00.000Z',
  documentId: 'doc-1',
  uploadedBy: 'u-1',
  chunkCount: 3,
  ...overrides,
});

const setup = () => {
  const message = { content: Buffer.from('{}'), fields: {}, properties: {} };
  const channel = { ack: vi.fn(), nack: vi.fn() };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  const indexer = { index: vi.fn<(id: string) => Promise<IndexOutcome>>() };
  const controller = new IndexingController(
    indexer as unknown as DocumentIndexer,
  );
  return { controller, indexer, channel, message, context };
};

describe('IndexingController', () => {
  it.each<IndexOutcome>([
    { kind: 'indexed', chunkCount: 3 },
    { kind: 'skipped', reason: 'document no longer exists' },
    { kind: 'failed', reason: 'EmbeddingError: Voyage responded 400' },
  ])(
    'acks when the outcome is $kind — the database has the answer',
    async (outcome) => {
      const { controller, indexer, channel, message, context } = setup();
      indexer.index.mockResolvedValue(outcome);

      await controller.onDocumentChunked(anEvent(), context);

      expect(indexer.index).toHaveBeenCalledWith('doc-1');
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(channel.nack).not.toHaveBeenCalled();
    },
  );

  it('dead-letters a deferred outcome instead of requeueing it', async () => {
    const { controller, indexer, channel, message, context } = setup();
    indexer.index.mockResolvedValue({ kind: 'deferred', reason: '503' });

    await controller.onDocumentChunked(anEvent(), context);

    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('dead-letters, and never throws, when the indexer itself fails', async () => {
    const { controller, indexer, channel, message, context } = setup();
    indexer.index.mockRejectedValue(new Error('database is down'));

    await expect(
      controller.onDocumentChunked(anEvent(), context),
    ).resolves.toBeUndefined();

    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('dead-letters a message without a documentId without asking the indexer', async () => {
    const { controller, indexer, channel, context } = setup();

    await controller.onDocumentChunked(
      anEvent({ documentId: undefined as unknown as string }),
      context,
    );

    expect(indexer.index).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledTimes(1);
  });
});
