import {
  integer,
  numeric,
  pgTable,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { answers } from './answers.js';
import { chunks } from './chunks.js';

/**
 * Which chunk each `[n]` in an answer pointed at — plan §6. Rows, not JSON in
 * `answers`,"tačnost citata" is a question about individual
 * citations: whether the cited segment really contains the claim.
 *
 * Only *valid* markers land here. A marker the model invented — an index that
 * was never in the context — has no chunk to reference, so it is counted on
 * `answers.citations_offered` and reported in the stream instead.
 *
 * `chunk_id` cascades: deleting a document deletes its chunks and with them
 * these rows. The drill-down is lost, deliberately — a citation whose chunk is
 * gone cannot be checked for accuracy anyway — while the counts survive on
 * `answers`.
 */
export const answerCitations = pgTable(
  'answer_citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    answerId: uuid('answer_id')
      .notNull()
      .references(() => answers.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    /** The `[n]` marker itself — its position in the prompt, 1-based. */
    rank: integer('rank').notNull(),
    /** Carried over from retrieval, so the log does not need a join to rank. */
    similarityScore: numeric('similarity_score', {
      precision: 8,
      scale: 6,
      mode: 'number',
    }),
  },
  (t) => [uniqueIndex('answer_citations_rank_idx').on(t.answerId, t.rank)],
);
