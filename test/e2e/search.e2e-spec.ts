/**
 * The query half end to end, over real TCP and Postgres: HTTP → api-gateway →
 * TCP → retrieval-service → pgvector + full-text → RRF → results.
 *
 * Three services boot here (auth-service for the tokens). Chunks and vectors
 * are planted directly, not uploaded: ingestion and indexing are proven by
 * their own suites, and what this one needs — a known corpus with known
 * visibility, including a document nobody has indexed yet — is only reachable
 * that way. Embeddings come from the `fake` provider, so no key and no
 * network; its vectors are deterministic and lexical, which is exactly enough
 * for a chunk sharing words with the question to win. Needs `DATABASE_URL`
 * (from `.env` locally, from the job env in CI) with the migrations applied.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  type AuthTokensDto,
  type DocumentVisibility,
  type SearchResultsDto,
  type UserRoleName,
} from '@app/common';
import {
  chunks,
  documents,
  DRIZZLE,
  type DrizzleDatabase,
  users,
} from '@app/database';
import { FakeEmbeddingProvider } from '@app/embeddings';
import { bearer, configureAuthEnv, PASSWORD, randomPort } from './helpers.js';

configureAuthEnv();
const RETRIEVAL_PORT = randomPort();
process.env.RETRIEVAL_HOST = '127.0.0.1';
process.env.RETRIEVAL_PORT = String(RETRIEVAL_PORT);
process.env.EMBEDDING_PROVIDER = 'fake';
process.env.RERANK_PROVIDER = 'none';

const DIMENSIONS = 1024;
const embeddings = new FakeEmbeddingProvider(DIMENSIONS);

/**
 * One clause per entry. The texts are chosen so the negatives are provable:
 * `termination` vs. the query word `terminating` only match after stemming,
 * and the confidentiality clause shares no meaningful word with the
 * termination question.
 */
const TERMINATION =
  'Either party may terminate this Agreement upon ninety days written notice of termination to the other party.';
const PAYMENT =
  'The Customer shall pay the Fees within thirty days of receipt of a valid invoice.';
const CONFIDENTIALITY =
  'Each party shall keep Confidential Information secret and shall not disclose it to any third party.';
const GOVERNING_LAW =
  'This Agreement is governed by the laws of Bosnia and Herzegovina.';

describe('search (e2e)', () => {
  let gateway: INestApplication;
  let auth: INestMicroservice;
  let retrieval: INestMicroservice;
  let db: DrizzleDatabase;

  const createdUserIds: string[] = [];
  const createdDocumentIds: string[] = [];

  let analyst: AuthTokensDto;
  let reader: AuthTokensDto;
  let admin: AuthTokensDto;
  let ownDocumentId: string;
  let sharedDocumentId: string;
  let foreignDocumentId: string;
  let unindexedDocumentId: string;

  const http = () => request(gateway.getHttpServer());

  /** Registers, promotes through the database, logs in again for a token that carries the role. */
  const userWithRole = async (role: UserRoleName): Promise<AuthTokensDto> => {
    const email = `e2e-search-${randomUUID()}@example.test`;
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

  /**
   * A document with its chunks already embedded — the state indexing-service
   * leaves behind. `embedded: false` plants the earlier state instead: chunks
   * with no vector, which nothing may find.
   */
  const plantDocument = async (
    ownerId: string,
    visibility: DocumentVisibility,
    contents: string[],
    { embedded = true } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(documents).values({
      id,
      title: `Search e2e ${id}`,
      originalFilename: 'contract-sample.pdf',
      storageKey: `documents/${id}/original.pdf`,
      mimeType: 'application/pdf',
      fileSize: 1,
      status: embedded ? 'indexed' : 'chunked',
      visibility,
      pageCount: 1,
      uploadedBy: ownerId,
    });
    const { vectors } = await embeddings.embed(contents, 'document');
    await db.insert(chunks).values(
      contents.map((content, chunkIndex) => ({
        documentId: id,
        chunkIndex,
        content,
        pageNumber: 1,
        sectionTitle: null,
        tokenCount: content.split(' ').length,
        embedding: embedded ? vectors[chunkIndex] : null,
      })),
    );
    createdDocumentIds.push(id);
    return id;
  };

  const search = (
    token: string,
    query: Record<string, string | number | boolean>,
  ) => http().get('/search').query(query).set(bearer(token));

  const searchOk = async (
    token: string,
    query: Record<string, string | number | boolean>,
  ): Promise<SearchResultsDto> => (await search(token, query).expect(200)).body;

  const contentsOf = (results: SearchResultsDto) =>
    results.results.map((result) => result.content);

  beforeAll(async () => {
    const [
      { AuthServiceModule },
      { RetrievalServiceModule },
      { ApiGatewayModule },
      { createValidationPipe },
    ] = await Promise.all([
      import('../../apps/auth-service/src/auth-service.module.js'),
      import('../../apps/retrieval-service/src/retrieval-service.module.js'),
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

    const retrievalModule = await Test.createTestingModule({
      imports: [RetrievalServiceModule],
    }).compile();
    retrieval = retrievalModule.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: RETRIEVAL_PORT },
      logger: false,
    });
    await retrieval.listen();

    const gatewayModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    }).compile();
    gateway = gatewayModule.createNestApplication({ logger: false });
    gateway.useGlobalPipes(createValidationPipe());
    await gateway.init();

    [analyst, reader, admin] = await Promise.all([
      userWithRole('analyst'),
      userWithRole('reader'),
      userWithRole('admin'),
    ]);
    const otherAnalyst = await userWithRole('analyst');

    [ownDocumentId, sharedDocumentId, foreignDocumentId, unindexedDocumentId] =
      await Promise.all([
        plantDocument(analyst.user.id, 'private', [TERMINATION, PAYMENT]),
        plantDocument(analyst.user.id, 'shared', [GOVERNING_LAW]),
        plantDocument(otherAnalyst.user.id, 'private', [CONFIDENTIALITY]),
        plantDocument(otherAnalyst.user.id, 'shared', [PAYMENT], {
          embedded: false,
        }),
      ]);
  });

  afterAll(async () => {
    if (db) {
      if (createdDocumentIds.length > 0) {
        await db
          .delete(documents)
          .where(inArray(documents.id, createdDocumentIds));
      }
      if (createdUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, createdUserIds));
      }
    }
    await gateway?.close();
    await retrieval?.close();
    await auth?.close();
  });

  describe('hybrid search', () => {
    it('finds the clause that answers the question', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'What notice is required to terminate the agreement?',
      });

      expect(results.results[0].content).toBe(TERMINATION);
      expect(results.results[0]).toMatchObject({
        documentId: ownDocumentId,
        chunkIndex: 0,
        pageNumber: 1,
      });
      expect(results.mode).toBe('hybrid');
      expect(results.reranker).toBe('none');
    });

    it('reports both branches, the fusion and where the time went', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'terminate the agreement',
      });

      expect(results.candidates.vector).toBeGreaterThan(0);
      expect(results.candidates.lexical).toBeGreaterThan(0);
      expect(results.candidates.fused).toBeGreaterThanOrEqual(
        results.candidates.lexical,
      );
      expect(results.timings.embeddingMs).toBeGreaterThan(0);
      expect(results.timings.totalMs).toBeGreaterThan(0);

      const top = results.results[0];
      expect(top.vectorRank).toBeGreaterThan(0);
      expect(top.lexicalRank).toBeGreaterThan(0);
      expect(top.similarity).toBeGreaterThan(0);
      expect(top.documentTitle).toContain('Search e2e');
    });

    it('honours the limit', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'agreement',
        limit: 1,
      });

      expect(results.results).toHaveLength(1);
    });
  });

  // Without migration 0005 the `tsv` column is `simple`, which indexes raw
  // tokens: `terminating` would match nothing at all.
  describe('stemming (migration 0005)', () => {
    it('matches `termination` for a question about `terminating`', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'terminating',
        mode: 'lexical',
      });

      expect(contentsOf(results)).toContain(TERMINATION);
    });

    it('still matches nothing for a word that is not in the corpus', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'cryptocurrency',
        mode: 'lexical',
      });

      expect(results.results).toEqual([]);
      expect(results.candidates.lexical).toBe(0);
    });
  });

  // The visibility filter is in the WHERE clause of both branches; a version
  // that filtered the results instead would pass the first assertion and fail
  // the count, having spent the candidates on chunks it then threw away.
  describe('visibility (ADR 014)', () => {
    it('never shows a reader another analyst’s private clause', async () => {
      const results = await searchOk(reader.accessToken, {
        q: 'confidential information disclosed to a third party',
      });

      expect(contentsOf(results)).not.toContain(CONFIDENTIALITY);
      expect(
        results.results.every((r) => r.documentId === sharedDocumentId),
      ).toBe(true);
    });

    it('shows an analyst their own private clause, and not a foreign one', async () => {
      const results = await searchOk(analyst.accessToken, {
        q: 'confidential information and termination notice',
      });
      const documentIds = new Set(results.results.map((r) => r.documentId));

      expect(documentIds).toContain(ownDocumentId);
      expect(documentIds).not.toContain(foreignDocumentId);
    });

    it('shows an admin everything', async () => {
      const results = await searchOk(admin.accessToken, {
        q: 'confidential information disclosed to a third party',
      });

      expect(contentsOf(results)).toContain(CONFIDENTIALITY);
    });

    it('scopes to one document when asked, and refuses an invisible one', async () => {
      const scoped = await searchOk(analyst.accessToken, {
        q: 'agreement',
        documentId: sharedDocumentId,
      });
      expect(
        scoped.results.every((r) => r.documentId === sharedDocumentId),
      ).toBe(true);

      const foreign = await searchOk(analyst.accessToken, {
        q: 'confidential information',
        documentId: foreignDocumentId,
      });
      expect(foreign.results).toEqual([]);
    });
  });

  describe('the corpus', () => {
    it('ignores a document whose chunks have no vector yet', async () => {
      for (const mode of ['hybrid', 'vector', 'lexical']) {
        const results = await searchOk(admin.accessToken, {
          q: 'fees within thirty days of a valid invoice',
          mode,
          limit: 50,
        });

        expect(results.results.map((r) => r.documentId)).not.toContain(
          unindexedDocumentId,
        );
      }
    });
  });

  describe('modes', () => {
    it('lexical returns only chunks that contain the words', async () => {
      const results = await searchOk(admin.accessToken, {
        q: 'invoice',
        mode: 'lexical',
        limit: 50,
      });

      expect(results.results.length).toBeGreaterThan(0);
      for (const result of results.results) {
        expect(result.content.toLowerCase()).toContain('invoice');
        expect(result.vectorRank).toBeNull();
      }
      expect(results.candidates.vector).toBe(0);
      expect(results.timings.embeddingMs).toBe(0);
    });

    it('vector reaches chunks the words alone would not', async () => {
      const results = await searchOk(admin.accessToken, {
        q: 'invoice',
        mode: 'vector',
        limit: 50,
      });

      expect(
        results.results.some(
          (result) => !result.content.toLowerCase().includes('invoice'),
        ),
      ).toBe(true);
      for (const result of results.results) {
        expect(result.lexicalRank).toBeNull();
      }
      expect(results.candidates.lexical).toBe(0);
    });

    it('hybrid keeps what each branch found first', async () => {
      const [hybrid, vector, lexical] = await Promise.all([
        searchOk(admin.accessToken, { q: 'invoice', limit: 50 }),
        searchOk(admin.accessToken, {
          q: 'invoice',
          mode: 'vector',
          limit: 50,
        }),
        searchOk(admin.accessToken, {
          q: 'invoice',
          mode: 'lexical',
          limit: 50,
        }),
      ]);
      const ids = new Set(hybrid.results.map((r) => r.chunkId));

      expect(ids).toContain(vector.results[0].chunkId);
      expect(ids).toContain(lexical.results[0].chunkId);
    });
  });

  describe('rejected requests', () => {
    it('needs a token', async () => {
      await http().get('/search').query({ q: 'anything' }).expect(401);
    });

    it('needs a question', async () => {
      await search(analyst.accessToken, { q: '' }).expect(400);
      await http().get('/search').set(bearer(analyst.accessToken)).expect(400);
    });

    it('rejects a limit, a mode or a document id it cannot honour', async () => {
      await search(analyst.accessToken, { q: 'x', limit: 100 }).expect(400);
      await search(analyst.accessToken, { q: 'x', mode: 'fuzzy' }).expect(400);
      await search(analyst.accessToken, { q: 'x', documentId: 'nope' }).expect(
        400,
      );
    });

    it('refuses a parameter it does not know (forbidNonWhitelisted)', async () => {
      await search(analyst.accessToken, { q: 'x', k: 5 }).expect(400);
    });
  });
});
