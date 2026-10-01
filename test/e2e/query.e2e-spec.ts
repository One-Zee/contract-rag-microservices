import { randomUUID } from 'node:crypto';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  type AuthTokensDto,
  type DocumentVisibility,
  type QueryDoneEventDto,
  type QueryMetaEventDto,
  type UserRoleName,
} from '@app/common';
import {
  answerCitations,
  answers,
  chunks,
  documents,
  DRIZZLE,
  type DrizzleDatabase,
  queries,
  users,
} from '@app/database';
import { FakeEmbeddingProvider } from '@app/embeddings';
import { bearer, configureAuthEnv, PASSWORD, randomPort } from './helpers.js';

configureAuthEnv();
const RETRIEVAL_PORT = randomPort();
const LLM_PORT = randomPort();
process.env.RETRIEVAL_HOST = '127.0.0.1';
process.env.RETRIEVAL_PORT = String(RETRIEVAL_PORT);
process.env.LLM_HOST = '127.0.0.1';
process.env.LLM_PORT = String(LLM_PORT);
process.env.EMBEDDING_PROVIDER = 'fake';
process.env.RERANK_PROVIDER = 'none';
process.env.LLM_PROVIDER = 'fake';
// The threshold ships disabled; the abstention tests below drive the
// no-context path instead, which is the one that does not depend on scale.
process.env.QUERY_MIN_SIMILARITY = '0';
process.env.LLM_COST_INPUT_PER_MTOK = '1';
process.env.LLM_COST_OUTPUT_PER_MTOK = '5';

const DIMENSIONS = 1024;
const embeddings = new FakeEmbeddingProvider(DIMENSIONS);

const TERMINATION =
  'Either party may terminate this Agreement upon ninety days written notice of termination to the other party.';
const PAYMENT =
  'The Customer shall pay the Fees within thirty days of receipt of a valid invoice.';
const CONFIDENTIALITY =
  'Each party shall keep Confidential Information secret and shall not disclose it to any third party.';

interface SseFrame {
  type?: string;
  data?: unknown;
}

/** The whole body arrives at once: supertest buffers `text/event-stream`. */
const parseSse = (body: string): SseFrame[] =>
  body
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const type = lines
        .find((line) => line.startsWith('event: '))
        ?.slice('event: '.length);
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return { type, data: data.length > 0 ? JSON.parse(data) : undefined };
    });

describe('query (e2e)', () => {
  let gateway: INestApplication;
  let auth: INestMicroservice;
  let retrieval: INestMicroservice;
  let llm: INestMicroservice;
  let db: DrizzleDatabase;

  const createdUserIds: string[] = [];
  const createdDocumentIds: string[] = [];

  let analyst: AuthTokensDto;
  let reader: AuthTokensDto;
  let ownDocumentId: string;
  let foreignDocumentId: string;

  const http = () => request(gateway.getHttpServer());

  const userWithRole = async (role: UserRoleName): Promise<AuthTokensDto> => {
    const email = `e2e-query-${randomUUID()}@example.test`;
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

  const plantDocument = async (
    ownerId: string,
    visibility: DocumentVisibility,
    contents: string[],
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(documents).values({
      id,
      title: `Query e2e ${id}`,
      originalFilename: 'contract-sample.pdf',
      storageKey: `documents/${id}/original.pdf`,
      mimeType: 'application/pdf',
      fileSize: 1,
      status: 'indexed',
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
        sectionTitle: 'Termination',
        tokenCount: content.split(' ').length,
        embedding: vectors[chunkIndex],
      })),
    );
    createdDocumentIds.push(id);
    return id;
  };

  const ask = (token: string, body: Record<string, unknown>) =>
    http().post('/query').send(body).set(bearer(token));

  const askOk = async (token: string, body: Record<string, unknown>) => {
    const response = await ask(token, body).expect(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = parseSse(response.text);
    return {
      frames,
      meta: frames.find((f) => f.type === 'meta')?.data as QueryMetaEventDto,
      done: frames.find((f) => f.type === 'done')?.data as QueryDoneEventDto,
      tokens: frames
        .filter((f) => f.type === 'token')
        .map((f) => (f.data as { text: string }).text),
    };
  };

  const latestQueryRow = async (userId: string) => {
    const [row] = await db
      .select()
      .from(queries)
      .where(eq(queries.userId, userId))
      .orderBy(desc(queries.createdAt))
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    const [
      { AuthServiceModule },
      { RetrievalServiceModule },
      { LlmServiceModule },
      { ApiGatewayModule },
      { createValidationPipe },
    ] = await Promise.all([
      import('../../apps/auth-service/src/auth-service.module.js'),
      import('../../apps/retrieval-service/src/retrieval-service.module.js'),
      import('../../apps/llm-service/src/llm-service.module.js'),
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

    const llmModule = await Test.createTestingModule({
      imports: [LlmServiceModule],
    }).compile();
    llm = llmModule.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: LLM_PORT },
      logger: false,
    });
    await llm.listen();

    const gatewayModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    }).compile();
    gateway = gatewayModule.createNestApplication({ logger: false });
    gateway.useGlobalPipes(createValidationPipe());
    await gateway.init();

    [analyst, reader] = await Promise.all([
      userWithRole('analyst'),
      userWithRole('reader'),
    ]);
    const otherAnalyst = await userWithRole('analyst');

    [ownDocumentId, foreignDocumentId] = await Promise.all([
      plantDocument(analyst.user.id, 'private', [TERMINATION, PAYMENT]),
      plantDocument(otherAnalyst.user.id, 'private', [CONFIDENTIALITY]),
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
    await llm?.close();
    await retrieval?.close();
    await auth?.close();
  });

  describe('the stream', () => {
    it('sends meta, then tokens, then done — and the tokens spell the answer', async () => {
      const { frames, meta, done, tokens } = await askOk(analyst.accessToken, {
        question: 'What notice is required to terminate the agreement?',
      });

      expect(frames[0].type).toBe('meta');
      expect(frames.at(-1)!.type).toBe('done');
      expect(tokens.length).toBeGreaterThan(1);
      expect(tokens.join('')).toBe(done.answer);
      expect(meta.queryId).toBe(done.queryId);
      expect(meta.model).toBe('fake-legal-assistant');
    });

    it('announces the excerpts before the answer starts', async () => {
      const { meta } = await askOk(analyst.accessToken, {
        question: 'What notice is required to terminate the agreement?',
      });

      expect(meta.sources.length).toBeGreaterThan(0);
      expect(meta.sources[0]).toMatchObject({
        marker: 1,
        documentId: ownDocumentId,
        pageNumber: 1,
        sectionTitle: 'Termination',
      });
    });

    it('cites the clause that answers the question', async () => {
      const { done } = await askOk(analyst.accessToken, {
        question: 'What notice is required to terminate the agreement?',
      });

      expect(done.citations).toHaveLength(1);
      expect(done.citations[0]).toMatchObject({
        marker: 1,
        documentId: ownDocumentId,
      });
      expect(done.invalidCitations).toEqual([]);
      expect(done.abstained).toBe(false);
      expect(done.status).toBe('answered');
    });
  });

  describe('the log', () => {
    it('writes one row in each of the three tables', async () => {
      const { done } = await askOk(analyst.accessToken, {
        question: 'What notice is required to terminate the agreement?',
        documentId: ownDocumentId,
      });

      const query = await latestQueryRow(analyst.user.id);
      expect(query).toMatchObject({
        id: done.queryId,
        status: 'answered',
        mode: 'hybrid',
        documentIds: [ownDocumentId],
        contextChunks: done.citations.length + 1,
      });
      expect(query.latencyMs).toBeGreaterThan(0);
      expect(query.llmMs).toBeGreaterThanOrEqual(0);
      expect(query.retrievalMs).toBeGreaterThanOrEqual(0);

      const [answer] = await db
        .select()
        .from(answers)
        .where(eq(answers.queryId, done.queryId));
      expect(answer).toMatchObject({
        id: done.answerId,
        provider: 'fake',
        model: 'fake-legal-assistant',
        abstained: false,
        citationsOffered: 1,
        citationsValid: 1,
      });
      expect(answer.tokensOut).toBeGreaterThan(0);
      expect(Number(answer.estimatedCost)).toBeGreaterThan(0);

      const citations = await db
        .select()
        .from(answerCitations)
        .where(eq(answerCitations.answerId, answer.id));
      expect(citations).toHaveLength(1);
      expect(citations[0].rank).toBe(1);
    });

    it('records the settings that were in force', async () => {
      await askOk(analyst.accessToken, { question: 'How is the fee paid?' });

      const query = await latestQueryRow(analyst.user.id);
      expect(Number(query.minSimilarity)).toBe(0);
      expect(query.contextChunks).toBeGreaterThan(0);
    });
  });

  describe('abstention', () => {
    it('declines, without calling the model, when nothing is retrievable', async () => {
      const { done, tokens } = await askOk(reader.accessToken, {
        question: 'What is the price of cryptocurrency in Antarctica?',
      });

      expect(done.abstained).toBe(true);
      expect(done.abstainReason).toBe('no_context');
      expect(done.status).toBe('abstained');
      expect(done.citations).toEqual([]);
      expect(done.usage.tokensOut).toBe(0);
      expect(tokens.join('')).toBe(done.answer);

      const [answer] = await db
        .select()
        .from(answers)
        .where(eq(answers.queryId, done.queryId));
      expect(answer.abstained).toBe(true);
      expect(answer.abstainReason).toBe('no_context');
    });

    it('declines when the model answers without grounding it in the excerpts', async () => {
      const { done } = await askOk(analyst.accessToken, {
        question: 'What notice is required? no-citation-please',
      });

      expect(done.abstained).toBe(true);
      expect(done.abstainReason).toBe('no_citations');
      expect(done.citations).toEqual([]);
    });
  });

  // The guardrail of plan §8.4: an answer that looks sourced and is not.
  it('excludes a citation index that was never in the context', async () => {
    const { done } = await askOk(analyst.accessToken, {
      question: 'What notice is required? bad-citation-please',
    });

    expect(done.invalidCitations).toEqual([9]);
    expect(done.citations).toEqual([]);

    const [answer] = await db
      .select()
      .from(answers)
      .where(eq(answers.queryId, done.queryId));
    expect(answer).toMatchObject({ citationsOffered: 1, citationsValid: 0 });
    expect(
      await db
        .select()
        .from(answerCitations)
        .where(eq(answerCitations.answerId, answer.id)),
    ).toHaveLength(0);
  });

  // Visibility is applied in retrieval's SQL, which only sees the caller's
  // identity because llm-service forwards the token it was given.
  it('never answers a reader out of another analyst’s private contract', async () => {
    const { meta, done } = await askOk(reader.accessToken, {
      question: 'What must each party keep confidential?',
    });

    const text = JSON.stringify({ meta, done });
    expect(text).not.toContain('Confidential Information secret');
    expect(
      meta.sources.every((source) => source.documentId !== foreignDocumentId),
    ).toBe(true);
    expect(done.abstained).toBe(true);
  });

  // Everything that is legitimately an HTTP failure must stay one: it happens
  // before the gateway hands the stream over, so the headers are not committed.
  describe('rejected requests answer as JSON, not as a stream', () => {
    it('refuses a request with no token', async () => {
      const response = await http()
        .post('/query')
        .send({ question: 'How much notice?' })
        .expect(401);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('refuses an empty question', async () => {
      const response = await ask(analyst.accessToken, { question: '' }).expect(
        400,
      );

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    /**
     * This is the one that proves the gateway's awaited prelude, and the only
     * one that can: the cases above are rejected by `JwtAuthGuard` and the
     * `ValidationPipe`, both of which run before the handler and would answer
     * with a status either way.
     *
     * A question of only whitespace passes `@MinLength(1)`, reaches
     * llm-service, and is refused *there* — asynchronously, after the handler
     * has been entered. Without the await, Nest would have committed
     * `200 text/event-stream` by then and this would arrive as an `error`
     * event on a successful response.
     */
    it('turns a refusal from llm-service into a status, not an error event', async () => {
      const response = await ask(analyst.accessToken, {
        question: '   ',
      }).expect(400);

      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.text).not.toContain('event: error');
      expect(response.body.message).toContain('question');
    });

    it('refuses an unknown field', async () => {
      await ask(analyst.accessToken, {
        question: 'How much notice?',
        pretendToBe: 'admin',
      }).expect(400);
    });

    it('refuses a documentId that is not a UUID', async () => {
      await ask(analyst.accessToken, {
        question: 'How much notice?',
        documentId: 'not-a-uuid',
      }).expect(400);
    });

    it('refuses a limit beyond the DTO bound', async () => {
      await ask(analyst.accessToken, {
        question: 'How much notice?',
        limit: 500,
      }).expect(400);
    });
  });

  describe('GET /query/history', () => {
    it('returns the caller’s own questions, newest first', async () => {
      const { done } = await askOk(analyst.accessToken, {
        question: 'What notice is required to terminate the agreement?',
      });

      const history = await http()
        .get('/query/history')
        .set(bearer(analyst.accessToken))
        .expect(200);

      expect(history.body.items[0]).toMatchObject({
        queryId: done.queryId,
        status: 'answered',
        model: 'fake-legal-assistant',
      });
      expect(history.body.total).toBeGreaterThan(0);
    });

    it('never shows one analyst another’s question', async () => {
      const { done } = await askOk(analyst.accessToken, {
        question: 'A question only the analyst asked, about termination',
      });

      const readerHistory = await http()
        .get('/query/history')
        .set(bearer(reader.accessToken))
        .expect(200);

      expect(
        readerHistory.body.items.some(
          (item: { queryId: string }) => item.queryId === done.queryId,
        ),
      ).toBe(false);
    });
  });
});
