/**
 * indexing-service end to end, over real RabbitMQ and Postgres: an event on
 * the `indexing` queue → embeddings → `UPDATE chunks SET embedding` →
 * `indexed` → `document.indexed`.
 *
 * Only indexing-service boots here. The documents suite proves upload →
 * `chunked` + event; this one proves event → `indexed`, plus the cases that
 * are only reachable by hand — the boot sweep, a deleted document, a
 * redelivered event, a document in another state — which need rows and
 * messages the suite plants itself. Embeddings come from the `fake` provider,
 * so no key and no network; the vectors are deterministic, which the tests
 * use. Needs `DATABASE_URL` and `RABBITMQ_URL` (from `.env` locally, from the
 * job env in CI) with the migrations applied.
 *
 * Note that the sweep at boot picks up *every* document in `chunked` or
 * `indexing` in the target database, not just this suite's — against a shared
 * development database, those get fake vectors.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import amqplib, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import type { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DOCUMENT_EVENTS,
  type DocumentChunkedEvent,
  documentChunkedEvent,
  type DocumentIndexedEvent,
  type DocumentStatus,
} from '@app/common';
import {
  chunks,
  documents,
  DRIZZLE,
  type DrizzleDatabase,
  users,
} from '@app/database';
import {
  DEAD_LETTER_QUEUE,
  EVENTS_EXCHANGE,
  EventPublisher,
  QUEUES,
  rmqConsumerOptions,
} from '@app/messaging';

process.env.EMBEDDING_PROVIDER = 'fake';

const DIMENSIONS = 1024;

describe('indexing (e2e)', () => {
  let app: INestMicroservice;
  let db: DrizzleDatabase;
  let publisher: EventPublisher;
  let broker: ChannelModel;
  let channel: Channel;
  const received: ConsumeMessage[] = [];

  let ownerId: string;
  const createdDocumentIds: string[] = [];
  /** Planted before the service boots, so the sweep — not an event — has to find it. */
  let sweptDocumentId: string;

  const insertDocument = async (
    status: DocumentStatus,
    contents: string[],
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(documents).values({
      id,
      title: `Indexing e2e ${id}`,
      originalFilename: 'contract-sample.pdf',
      storageKey: `documents/${id}/original.pdf`,
      mimeType: 'application/pdf',
      fileSize: 1,
      status,
      visibility: 'private',
      pageCount: 1,
      uploadedBy: ownerId,
    });
    if (contents.length > 0) {
      await db.insert(chunks).values(
        contents.map((content, chunkIndex) => ({
          documentId: id,
          chunkIndex,
          content,
          pageNumber: 1,
          sectionTitle: null,
          tokenCount: content.split(' ').length,
        })),
      );
    }
    createdDocumentIds.push(id);
    return id;
  };

  const documentRow = async (id: string) => {
    const [row] = await db
      .select({
        status: documents.status,
        errorMessage: documents.errorMessage,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(eq(documents.id, id));
    return row;
  };

  const chunkRows = (id: string) =>
    db
      .select({
        chunkIndex: chunks.chunkIndex,
        content: chunks.content,
        embedding: chunks.embedding,
        dims: sql<number | null>`vector_dims(${chunks.embedding})`,
      })
      .from(chunks)
      .where(eq(chunks.documentId, id))
      .orderBy(asc(chunks.chunkIndex));

  const waitForStatus = async (
    id: string,
    terminal: DocumentStatus[],
    timeoutMs = 15_000,
  ): Promise<DocumentStatus> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await documentRow(id);
      if (terminal.includes(row.status)) {
        return row.status;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Document ${id} still ${row.status} after ${timeoutMs} ms`,
        );
      }
      await sleep(200);
    }
  };

  const indexedEventsFor = (documentId: string) =>
    received.filter(
      (message) =>
        (JSON.parse(message.content.toString()).data as DocumentIndexedEvent)
          .documentId === documentId,
    );

  const waitForIndexedEvent = async (documentId: string, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (indexedEventsFor(documentId).length === 0) {
      if (Date.now() > deadline) {
        throw new Error(`No document.indexed for ${documentId}`);
      }
      await sleep(100);
    }
  };

  const queueDepth = async (queue: string) =>
    (await channel.checkQueue(queue)).messageCount;

  beforeAll(async () => {
    const { IndexingServiceModule } =
      await import('../../apps/indexing-service/src/indexing-service.module.js');

    // Compiling instantiates the providers (and the pool) without running the
    // bootstrap hooks, so rows can be planted before the sweep looks.
    const moduleRef = await Test.createTestingModule({
      imports: [IndexingServiceModule],
    }).compile();
    db = moduleRef.get<DrizzleDatabase>(DRIZZLE);
    publisher = moduleRef.get(EventPublisher);

    const [owner] = await db
      .insert(users)
      .values({
        email: `e2e-indexing-${randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'analyst',
      })
      .returning({ id: users.id });
    ownerId = owner.id;
    sweptDocumentId = await insertDocument('chunked', [
      'ARTICLE 1 - DEFINITIONS',
      'The Effective Date is the date first written above.',
    ]);

    // The suite's own subscription to `document.indexed`: an exclusive queue
    // on the exchange, so the real queues are left alone.
    broker = await amqplib.connect(process.env.RABBITMQ_URL!);
    channel = await broker.createChannel();
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, DOCUMENT_EVENTS.INDEXED);
    await channel.consume(
      queue,
      (message) => message && received.push(message),
      { noAck: true },
    );

    app = moduleRef.createNestMicroservice({
      ...rmqConsumerOptions(process.env.RABBITMQ_URL!, QUEUES.INDEXING),
      logger: false,
    });
    await app.listen();
  });

  afterAll(async () => {
    if (db) {
      if (createdDocumentIds.length > 0) {
        await db
          .delete(documents)
          .where(inArray(documents.id, createdDocumentIds));
      }
      if (ownerId) {
        await db.delete(users).where(eq(users.id, ownerId));
      }
    }
    await channel?.close().catch(() => undefined);
    await broker?.close().catch(() => undefined);
    await app?.close();
  });

  describe('boot sweep', () => {
    it('indexes a document left in `chunked` without any event', async () => {
      await expect(
        waitForStatus(sweptDocumentId, ['indexed', 'failed']),
      ).resolves.toBe('indexed');

      const rows = await chunkRows(sweptDocumentId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.dims).toBe(DIMENSIONS);
      }
      await waitForIndexedEvent(sweptDocumentId);
    });
  });

  describe('document.chunked → indexed', () => {
    let documentId: string;
    let event: DocumentChunkedEvent;
    let vectorsAfterFirstRun: (number[] | null)[];

    it('reaches `indexed` with a 1024-dimensional vector on every chunk', async () => {
      documentId = await insertDocument('chunked', [
        'Either party may terminate this Agreement with ninety days notice.',
        'The Supplier warrants that the Services are free from defects.',
        'Governing law: the laws of Bosnia and Herzegovina.',
        // the same text as chunk 0 — same vector, proves determinism below
        'Either party may terminate this Agreement with ninety days notice.',
      ]);
      const before = await documentRow(documentId);
      event = documentChunkedEvent({
        documentId,
        uploadedBy: ownerId,
        chunkCount: 4,
      });

      await publisher.publish(event);

      await expect(
        waitForStatus(documentId, ['indexed', 'failed']),
      ).resolves.toBe('indexed');
      const after = await documentRow(documentId);
      expect(after.errorMessage).toBeNull();
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );

      const rows = await chunkRows(documentId);
      expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1, 2, 3]);
      for (const row of rows) {
        expect(row.embedding).toHaveLength(DIMENSIONS);
        expect(row.dims).toBe(DIMENSIONS);
      }
      expect(rows[3].embedding).toEqual(rows[0].embedding);
      expect(rows[1].embedding).not.toEqual(rows[0].embedding);
      vectorsAfterFirstRun = rows.map((r) => r.embedding);
    });

    it('published exactly one document.indexed for it, id as messageId, persistent', async () => {
      await waitForIndexedEvent(documentId);
      await sleep(300);

      const events = indexedEventsFor(documentId);
      expect(events).toHaveLength(1);
      const [message] = events;
      const payload = JSON.parse(message.content.toString());
      expect(payload.pattern).toBe(DOCUMENT_EVENTS.INDEXED);
      expect(payload.data).toMatchObject({
        type: DOCUMENT_EVENTS.INDEXED,
        documentId,
        uploadedBy: ownerId,
        chunkCount: 4,
      });
      expect(message.properties.messageId).toBe(payload.data.eventId);
      expect(message.properties.deliveryMode).toBe(2);
      expect(message.fields.routingKey).toBe(DOCUMENT_EVENTS.INDEXED);
    });

    it('treats a redelivery of the same event as a no-op', async () => {
      await publisher.publish(event);
      await sleep(1_000);

      expect(await documentRow(documentId)).toMatchObject({
        status: 'indexed',
        errorMessage: null,
      });
      expect(indexedEventsFor(documentId)).toHaveLength(1);
      const rows = await chunkRows(documentId);
      expect(rows.map((r) => r.embedding)).toEqual(vectorsAfterFirstRun);
    });
  });

  describe('events that must not index anything', () => {
    it('leaves a `failed` document alone', async () => {
      const documentId = await insertDocument('failed', [
        'This document failed at chunking and must stay that way.',
      ]);

      await publisher.publish(
        documentChunkedEvent({
          documentId,
          uploadedBy: ownerId,
          chunkCount: 1,
        }),
      );
      await sleep(1_000);

      expect((await documentRow(documentId)).status).toBe('failed');
      expect((await chunkRows(documentId))[0].embedding).toBeNull();
      expect(indexedEventsFor(documentId)).toHaveLength(0);
    });

    it('consumes an event for a document that no longer exists instead of dead-lettering it', async () => {
      const deadLettersBefore = await queueDepth(DEAD_LETTER_QUEUE);

      await publisher.publish(
        documentChunkedEvent({
          documentId: randomUUID(),
          uploadedBy: ownerId,
          chunkCount: 3,
        }),
      );
      await sleep(1_000);

      expect(await queueDepth(QUEUES.INDEXING)).toBe(0);
      expect(await queueDepth(DEAD_LETTER_QUEUE)).toBe(deadLettersBefore);
    });

    it('is still consuming afterwards', async () => {
      const documentId = await insertDocument('chunked', [
        'A clause after the deleted document, to prove the consumer is alive.',
      ]);

      await publisher.publish(
        documentChunkedEvent({
          documentId,
          uploadedBy: ownerId,
          chunkCount: 1,
        }),
      );

      await expect(
        waitForStatus(documentId, ['indexed', 'failed']),
      ).resolves.toBe('indexed');
    });
  });
});
