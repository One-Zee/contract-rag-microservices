/**
 * The ingestion flow end to end, over real TCP, Postgres, MinIO and RabbitMQ:
 * HTTP → api-gateway → TCP → ingestion-service → S3 + Drizzle → `document.chunked`.
 *
 * Three services boot in this process (auth-service for the tokens). Needs
 * `DATABASE_URL`, `RABBITMQ_URL` and `S3_*` (from `.env` locally, from the job
 * env in CI) with the migrations applied; everything else is generated here.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import amqplib, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import {
  type ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { lastValueFrom } from 'rxjs';
import request from 'supertest';
import {
  type AuthTokensDto,
  DOCUMENT_EVENTS,
  type DocumentChunkedEvent,
  type DocumentDto,
  type DocumentStatus,
  type DocumentStatusDto,
  INGESTION_PATTERNS,
  type PaginatedDocumentsDto,
  type RpcErrorShape,
  type UploadDocumentRpcPayload,
  type UserRoleName,
} from '@app/common';
import {
  chunks,
  documents,
  DRIZZLE,
  type DrizzleDatabase,
  users,
} from '@app/database';
import { EVENTS_EXCHANGE } from '@app/messaging';
import {
  bearer,
  configureAuthEnv,
  PASSWORD,
  randomPort,
  rsaPair,
  signWith,
} from './helpers.js';

configureAuthEnv();
const INGESTION_PORT = randomPort();
// Small enough that the 413 case does not need a large body; the fixtures are ~10 KB.
const UPLOAD_MAX_BYTES = 64 * 1024;
process.env.INGESTION_HOST = '127.0.0.1';
process.env.INGESTION_PORT = String(INGESTION_PORT);
process.env.UPLOAD_MAX_BYTES = String(UPLOAD_MAX_BYTES);

const PDF = 'application/pdf';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FIXTURE_PAGES = 3;

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const pdfFixture = fixture('contract-sample.pdf');
const docxFixture = fixture('contract-sample.docx');
const blankFixture = fixture('blank.pdf');

describe('documents (e2e)', () => {
  let gateway: INestApplication;
  let auth: INestMicroservice;
  let ingestion: INestMicroservice;
  let db: DrizzleDatabase;
  let storage: { exists(key: string): Promise<boolean> };
  let broker: ChannelModel;
  let channel: Channel;
  const received: ConsumeMessage[] = [];

  const createdUserIds: string[] = [];
  const createdDocumentIds: string[] = [];

  const http = () => request(gateway.getHttpServer());

  /** Registers, promotes through the database, logs in again for a token that carries the role. */
  const userWithRole = async (role: UserRoleName): Promise<AuthTokensDto> => {
    const email = `e2e-doc-${randomUUID()}@example.test`;
    const registered = await http()
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    createdUserIds.push(registered.body.user.id);
    await db
      .update(users)
      .set({ role })
      .where(eq(users.id, registered.body.user.id));
    const login = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return login.body;
  };

  const upload = (
    token: string,
    file: Buffer,
    {
      filename = 'contract-sample.pdf',
      contentType = PDF,
      fields = {} as Record<string, string>,
    } = {},
  ) => {
    let req = http().post('/documents').set(bearer(token));
    for (const [name, value] of Object.entries(fields)) {
      req = req.field(name, value);
    }
    return req.attach('file', file, { filename, contentType });
  };

  const track = (document: DocumentDto): DocumentDto => {
    createdDocumentIds.push(document.id);
    return document;
  };

  const waitForStatus = async (
    id: string,
    token: string,
    terminal: DocumentStatus[],
    timeoutMs = 15_000,
  ): Promise<DocumentStatusDto> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await http()
        .get(`/documents/${id}/status`)
        .set(bearer(token))
        .expect(200);
      if (terminal.includes(res.body.status)) {
        return res.body;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Document ${id} still ${res.body.status} after ${timeoutMs} ms`,
        );
      }
      await sleep(200);
    }
  };

  let analyst: AuthTokensDto;
  let otherAnalyst: AuthTokensDto;
  let reader: AuthTokensDto;
  let admin: AuthTokensDto;

  beforeAll(async () => {
    const [
      { AuthServiceModule },
      { IngestionServiceModule },
      { StorageService },
      { ApiGatewayModule },
      { createValidationPipe },
    ] = await Promise.all([
      import('../../apps/auth-service/src/auth-service.module.js'),
      import('../../apps/ingestion-service/src/ingestion-service.module.js'),
      import('../../apps/ingestion-service/src/storage/storage.service.js'),
      import('../../apps/api-gateway/src/api-gateway.module.js'),
      import('../../apps/api-gateway/src/validation.js'),
    ]);

    const authModule = await Test.createTestingModule({
      imports: [AuthServiceModule],
    }).compile();
    auth = authModule.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: Number(process.env.AUTH_PORT) },
      logger: false,
    });
    await auth.listen();
    db = authModule.get<DrizzleDatabase>(DRIZZLE);

    const ingestionModule = await Test.createTestingModule({
      imports: [IngestionServiceModule],
    }).compile();
    ingestion = ingestionModule.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: INGESTION_PORT },
      logger: false,
    });
    await ingestion.listen();
    storage = ingestionModule.get(StorageService);

    const gatewayModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    }).compile();
    gateway = gatewayModule.createNestApplication({ logger: false });
    gateway.useGlobalPipes(createValidationPipe());
    await gateway.init();

    // The suite's own subscription to `document.chunked`: an exclusive queue
    // bound to the exchange ingestion-service declared at boot. The real
    // `indexing` queue is left alone for indexing-service.
    broker = await amqplib.connect(process.env.RABBITMQ_URL!);
    channel = await broker.createChannel();
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, DOCUMENT_EVENTS.CHUNKED);
    await channel.consume(
      queue,
      (message) => message && received.push(message),
      { noAck: true },
    );

    [analyst, otherAnalyst, reader, admin] = await Promise.all([
      userWithRole('analyst'),
      userWithRole('analyst'),
      userWithRole('reader'),
      userWithRole('admin'),
    ]);
  });

  afterAll(async () => {
    if (db) {
      if (createdDocumentIds.length > 0) {
        const rows = await db
          .select({ id: documents.id, storageKey: documents.storageKey })
          .from(documents)
          .where(inArray(documents.id, createdDocumentIds));
        for (const row of rows) {
          await http()
            .delete(`/documents/${row.id}`)
            .set(bearer(admin.accessToken));
        }
        await db
          .delete(documents)
          .where(inArray(documents.id, createdDocumentIds));
      }
      if (createdUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, createdUserIds));
      }
    }
    await channel?.close().catch(() => undefined);
    await broker?.close().catch(() => undefined);
    await gateway?.close();
    await ingestion?.close();
    await auth?.close();
  });

  describe('happy path', () => {
    let document: DocumentDto;
    let status: DocumentStatusDto;

    it('accepts a PDF from an analyst and returns the row before processing', async () => {
      const res = await upload(analyst.accessToken, pdfFixture, {
        fields: { title: 'Master Services Agreement' },
      }).expect(202);

      document = track(res.body);
      expect(document).toMatchObject({
        title: 'Master Services Agreement',
        originalFilename: 'contract-sample.pdf',
        mimeType: PDF,
        fileSize: pdfFixture.length,
        status: 'uploaded',
        visibility: 'private',
        uploadedBy: analyst.user.id,
        pageCount: null,
        errorMessage: null,
      });
      expect(document).not.toHaveProperty('storageKey');
    });

    it('reaches `chunked` with the page count and a chunk count', async () => {
      status = await waitForStatus(document.id, analyst.accessToken, [
        'chunked',
        'failed',
      ]);

      expect(status).toMatchObject({
        id: document.id,
        status: 'chunked',
        pageCount: FIXTURE_PAGES,
        errorMessage: null,
      });
      expect(status.chunkCount).toBeGreaterThanOrEqual(3);
    });

    it('wrote chunks that are ordered, within budget, page- and section-labelled, and searchable', async () => {
      const rows = await db
        .select({
          chunkIndex: chunks.chunkIndex,
          pageNumber: chunks.pageNumber,
          sectionTitle: chunks.sectionTitle,
          tokenCount: chunks.tokenCount,
          embedding: chunks.embedding,
          hasTsv: sql<boolean>`tsv IS NOT NULL`,
        })
        .from(chunks)
        .where(eq(chunks.documentId, document.id))
        .orderBy(asc(chunks.chunkIndex));

      expect(rows).toHaveLength(status.chunkCount);
      expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
      expect(rows[0].pageNumber).toBe(1);
      expect(rows.at(-1)!.pageNumber).toBe(FIXTURE_PAGES);
      expect(rows.map((r) => r.sectionTitle)).toContain('ARTICLE 2 - SERVICES');
      for (const row of rows) {
        expect(row.tokenCount).toBeLessThanOrEqual(800);
        expect(row.hasTsv).toBe(true);
        // indexing-service's column, untouched here
        expect(row.embedding).toBeNull();
      }
    });

    it('kept the original in object storage', async () => {
      const [row] = await db
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(eq(documents.id, document.id));

      expect(row.storageKey).toBe(`documents/${document.id}/original.pdf`);
      await expect(storage.exists(row.storageKey)).resolves.toBe(true);
    });

    it('published exactly one document.chunked event for it, id as messageId', async () => {
      const deadline = Date.now() + 5_000;
      while (
        !received.some(
          (m) =>
            JSON.parse(m.content.toString()).data.documentId === document.id,
        )
      ) {
        if (Date.now() > deadline) {
          throw new Error('document.chunked never arrived');
        }
        await sleep(100);
      }
      const mine = received.filter(
        (m) => JSON.parse(m.content.toString()).data.documentId === document.id,
      );

      expect(mine).toHaveLength(1);
      const { pattern, data } = JSON.parse(mine[0].content.toString()) as {
        pattern: string;
        data: DocumentChunkedEvent;
      };
      expect(pattern).toBe(DOCUMENT_EVENTS.CHUNKED);
      expect(mine[0].fields.routingKey).toBe(DOCUMENT_EVENTS.CHUNKED);
      expect(data).toMatchObject({
        type: DOCUMENT_EVENTS.CHUNKED,
        documentId: document.id,
        uploadedBy: analyst.user.id,
        chunkCount: status.chunkCount,
      });
      expect(mine[0].properties.messageId).toBe(data.eventId);
      expect(mine[0].properties.deliveryMode).toBe(2);
    });

    it('serves the document and lists it for its uploader', async () => {
      const single = await http()
        .get(`/documents/${document.id}`)
        .set(bearer(analyst.accessToken))
        .expect(200);
      expect(single.body).toMatchObject({
        id: document.id,
        status: 'chunked',
        pageCount: FIXTURE_PAGES,
      });

      const list = await http()
        .get('/documents')
        .query({ limit: 100, status: 'chunked' })
        .set(bearer(analyst.accessToken))
        .expect(200);
      const page: PaginatedDocumentsDto = list.body;
      expect(page).toMatchObject({ page: 1, limit: 100 });
      expect(page.items.map((d) => d.id)).toContain(document.id);
      expect(page.total).toBeGreaterThanOrEqual(1);
    });

    it('chunks a DOCX the same way, without page numbers', async () => {
      const res = await upload(analyst.accessToken, docxFixture, {
        filename: 'contract-sample.docx',
        contentType: DOCX,
      }).expect(202);
      const docx = track(res.body);
      expect(docx.title).toBe('contract-sample');

      const docxStatus = await waitForStatus(docx.id, analyst.accessToken, [
        'chunked',
        'failed',
      ]);
      expect(docxStatus).toMatchObject({ status: 'chunked', pageCount: null });
      expect(docxStatus.chunkCount).toBeGreaterThanOrEqual(3);

      const [row] = await db
        .select({ pageNumber: chunks.pageNumber })
        .from(chunks)
        .where(eq(chunks.documentId, docx.id))
        .limit(1);
      expect(row.pageNumber).toBeNull();
    });
  });

  describe('documents that cannot be processed end in `failed` with a reason', () => {
    it('a PDF without a text layer', async () => {
      const res = await upload(analyst.accessToken, blankFixture, {
        filename: 'scan.pdf',
      }).expect(202);
      const status = await waitForStatus(
        track(res.body).id,
        analyst.accessToken,
        ['chunked', 'failed'],
      );

      expect(status.status).toBe('failed');
      expect(status.errorMessage).toContain('No extractable text');
      expect(status.chunkCount).toBe(0);
    });

    it('bytes with a PDF signature but no PDF behind it', async () => {
      const fake = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(2_000, 'x'),
      ]);
      const res = await upload(analyst.accessToken, fake, {
        filename: 'broken.pdf',
      }).expect(202);
      const status = await waitForStatus(
        track(res.body).id,
        analyst.accessToken,
        ['chunked', 'failed'],
      );

      expect(status.status).toBe('failed');
      expect(status.errorMessage).toMatch(/InvalidPDF/);
    });
  });

  describe('rejections at the gateway', () => {
    it('without a token', async () => {
      await http()
        .post('/documents')
        .attach('file', pdfFixture, 'x.pdf')
        .expect(401);
    });

    it('from a reader (403) — before any byte reaches ingestion', async () => {
      const before = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(documents);
      await upload(reader.accessToken, pdfFixture).expect(403);
      const after = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(documents);

      expect(after[0].n).toBe(before[0].n);
    });

    it('a text file (415)', async () => {
      await upload(analyst.accessToken, Buffer.from('just text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      }).expect(415);
    });

    it('a file over UPLOAD_MAX_BYTES (413)', async () => {
      const big = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(UPLOAD_MAX_BYTES, 'x'),
      ]);
      await upload(analyst.accessToken, big).expect(413);
    });

    it('content that does not match its declared type (400)', async () => {
      await upload(
        analyst.accessToken,
        Buffer.from('plain text in a pdf costume'),
        {
          filename: 'costume.pdf',
          contentType: PDF,
        },
      ).expect(400);
    });

    it('a request without the file part (400)', async () => {
      await http()
        .post('/documents')
        .set(bearer(analyst.accessToken))
        .field('title', 'no file')
        .expect(400);
    });

    it('an unknown multipart field (400, forbidNonWhitelisted)', async () => {
      await upload(analyst.accessToken, pdfFixture, {
        fields: { role: 'admin' },
      }).expect(400);
    });

    it('an unknown visibility (400)', async () => {
      await upload(analyst.accessToken, pdfFixture, {
        fields: { visibility: 'public' },
      }).expect(400);
    });

    it('a malformed id and out-of-range paging (400)', async () => {
      await http()
        .get('/documents/not-a-uuid')
        .set(bearer(analyst.accessToken))
        .expect(400);
      await http()
        .get('/documents')
        .query({ limit: 0 })
        .set(bearer(analyst.accessToken))
        .expect(400);
      await http()
        .get('/documents')
        .query({ limit: 101 })
        .set(bearer(analyst.accessToken))
        .expect(400);
      await http()
        .get('/documents')
        .query({ status: 'done' })
        .set(bearer(analyst.accessToken))
        .expect(400);
    });
  });

  describe('the service enforces the same rules without the gateway', () => {
    let client: ClientProxy;

    beforeAll(async () => {
      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port: INGESTION_PORT },
      });
      await client.connect();
    });

    afterAll(async () => {
      await client?.close();
    });

    const call = (payload: Partial<UploadDocumentRpcPayload>) =>
      lastValueFrom(
        client.send(INGESTION_PATTERNS.DOCUMENT_UPLOAD, payload),
      ).then(
        () => {
          throw new Error('expected the call to be rejected');
        },
        (error: RpcErrorShape) => error,
      );

    const validPayload = (accessToken: string): UploadDocumentRpcPayload => ({
      accessToken,
      originalFilename: 'contract-sample.pdf',
      mimeType: PDF,
      contentBase64: pdfFixture.toString('base64'),
    });

    it('rejects a reader with 403 on the RPC itself', async () => {
      const error = await call(validPayload(reader.accessToken));

      expect(error.statusCode).toBe(403);
    });

    it('rejects a missing token and a token signed with a foreign key with 401', async () => {
      const { accessToken: _omitted, ...withoutToken } = validPayload(
        analyst.accessToken,
      );
      expect((await call(withoutToken)).statusCode).toBe(401);

      const forged = signWith(rsaPair().privateKey).sign({
        sub: analyst.user.id,
        email: analyst.user.email,
        roles: ['admin'],
      });
      expect((await call(validPayload(forged))).statusCode).toBe(401);
    });

    it('re-checks the size limit on the encoded payload', async () => {
      const error = await call({
        ...validPayload(analyst.accessToken),
        contentBase64: 'A'.repeat(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4),
      });

      expect(error.statusCode).toBe(413);
    });

    it('takes the owner from the token, not from the payload', async () => {
      const res = await lastValueFrom(
        client.send<DocumentDto>(INGESTION_PATTERNS.DOCUMENT_UPLOAD, {
          ...validPayload(analyst.accessToken),
          uploadedBy: admin.user.id,
        }),
      );
      track(res);

      expect(res.uploadedBy).toBe(analyst.user.id);
    });
  });

  describe('visibility and ownership', () => {
    let privateDoc: DocumentDto;

    beforeAll(async () => {
      const res = await upload(analyst.accessToken, pdfFixture, {
        fields: { title: 'Visibility subject' },
      }).expect(202);
      privateDoc = track(res.body);
      await waitForStatus(privateDoc.id, analyst.accessToken, [
        'chunked',
        'failed',
      ]);
    });

    const idsVisibleTo = async (token: string) => {
      const res = await http()
        .get('/documents')
        .query({ limit: 100 })
        .set(bearer(token))
        .expect(200);
      return (res.body as PaginatedDocumentsDto).items.map((d) => d.id);
    };

    it('hides a private document from a reader and from another analyst (404, not 403)', async () => {
      expect(await idsVisibleTo(reader.accessToken)).not.toContain(
        privateDoc.id,
      );
      expect(await idsVisibleTo(otherAnalyst.accessToken)).not.toContain(
        privateDoc.id,
      );
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(reader.accessToken))
        .expect(404);
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(otherAnalyst.accessToken))
        .expect(404);
      await http()
        .get(`/documents/${privateDoc.id}/status`)
        .set(bearer(otherAnalyst.accessToken))
        .expect(404);
    });

    it('shows it to an admin regardless', async () => {
      expect(await idsVisibleTo(admin.accessToken)).toContain(privateDoc.id);
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(admin.accessToken))
        .expect(200);
    });

    it('lets only the uploader share it — a reader or another analyst cannot even see it to try', async () => {
      await http()
        .patch(`/documents/${privateDoc.id}`)
        .set(bearer(otherAnalyst.accessToken))
        .send({ visibility: 'shared' })
        .expect(404);

      const res = await http()
        .patch(`/documents/${privateDoc.id}`)
        .set(bearer(analyst.accessToken))
        .send({ visibility: 'shared', title: 'Now shared' })
        .expect(200);
      expect(res.body).toMatchObject({
        visibility: 'shared',
        title: 'Now shared',
      });
    });

    it('once shared, every authenticated user can read it', async () => {
      expect(await idsVisibleTo(reader.accessToken)).toContain(privateDoc.id);
      expect(await idsVisibleTo(otherAnalyst.accessToken)).toContain(
        privateDoc.id,
      );
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(reader.accessToken))
        .expect(200);
    });

    it('but only the uploader or an admin may change or delete it (403)', async () => {
      await http()
        .patch(`/documents/${privateDoc.id}`)
        .set(bearer(reader.accessToken))
        .send({ title: 'x' })
        .expect(403);
      await http()
        .delete(`/documents/${privateDoc.id}`)
        .set(bearer(otherAnalyst.accessToken))
        .expect(403);
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(analyst.accessToken))
        .expect(200);
    });

    it('rejects an empty patch (400)', async () => {
      await http()
        .patch(`/documents/${privateDoc.id}`)
        .set(bearer(analyst.accessToken))
        .send({})
        .expect(400);
    });

    it('an admin can delete it', async () => {
      await http()
        .delete(`/documents/${privateDoc.id}`)
        .set(bearer(admin.accessToken))
        .expect(204);
      await http()
        .get(`/documents/${privateDoc.id}`)
        .set(bearer(analyst.accessToken))
        .expect(404);
    });
  });

  describe('deletion by the uploader', () => {
    it('removes the row, its chunks and the stored original', async () => {
      const res = await upload(analyst.accessToken, pdfFixture).expect(202);
      const doc = track(res.body);
      await waitForStatus(doc.id, analyst.accessToken, ['chunked', 'failed']);
      const [{ storageKey }] = await db
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(eq(documents.id, doc.id));
      await expect(storage.exists(storageKey)).resolves.toBe(true);

      await http()
        .delete(`/documents/${doc.id}`)
        .set(bearer(analyst.accessToken))
        .expect(204);

      await http()
        .get(`/documents/${doc.id}`)
        .set(bearer(analyst.accessToken))
        .expect(404);
      await expect(storage.exists(storageKey)).resolves.toBe(false);
      const remaining = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.documentId, doc.id));
      expect(remaining).toHaveLength(0);
    });

    it('answers 404 for a second delete', async () => {
      await http()
        .delete(`/documents/${randomUUID()}`)
        .set(bearer(analyst.accessToken))
        .expect(404);
    });
  });
});
