import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const queryStatus = pgEnum('query_status', [
  'answered',
  'abstained',
  'failed',
  'abandoned',
]);

/**
 *
 * The row is inserted *before* the model is called and completed afterwards.
 * That ordering is not incidental: the id is the handle the client gets in the
 * `meta` event and uses to cancel, and a crash mid-generation still has to
 * leave a denominator behind — a query that produced no answer is data, not an
 * absence.
 *
 * `min_similarity` and `context_chunks` record the settings that were in force,
 * for the same reason `HNSW_EF_SEARCH` is recorded: a comparison between two
 * measurements is only honest if it can say what differed.
 */
export const queries = pgTable(
  'queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    // The API takes at most one document (retrieval's contract takes one), but
    // the column is an array because §6 specifies one and because widening the
    // request later must not mean another migration.
    documentIds: uuid('document_ids').array(),
    mode: text('mode').notNull(),
    contextChunks: integer('context_chunks').notNull().default(0),
    minSimilarity: numeric('min_similarity', {
      precision: 4,
      scale: 3,
      mode: 'number',
    }),
    status: queryStatus('status').notNull().default('failed'),
    // Milliseconds, as measured by whoever knows: the first three come back
    // from retrieval-service, the last two are llm-service's own clock.
    embeddingMs: integer('embedding_ms'),
    retrievalMs: integer('retrieval_ms'),
    rerankMs: integer('rerank_ms'),
    llmMs: integer('llm_ms'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // `/query/history` reads exactly this: one user's rows, newest first.
    index('queries_user_created_idx').on(t.userId, t.createdAt.desc()),
  ],
);
