import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { queries } from './queries.js';

export const abstainReason = pgEnum('abstain_reason', [
  'no_context',
  'below_threshold',
  'no_citations',
]);

/**
 * What the system answered — one row per query.
 *
 * An abstention is an answer too: it gets a row, with the fallback sentence as
 * `content` and `abstained` set. That is what makes §9.3's "stopa uzdržavanja"
 * a single `AVG(abstained::int)` rather than a join against rows that are not
 * there.
 *
 * `citations_offered` / `citations_valid` are the aggregate behind §9.3's
 * "tačnost citata", and they are kept here rather than derived from
 * `answer_citations` because that table loses rows when a document is deleted
 * — the counts have to outlive the corpus.
 */
export const answers = pgTable('answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Unique: phase 5 answers a query exactly once. A retry policy would need a
  // different shape, and should have to say so.
  queryId: uuid('query_id')
    .notNull()
    .unique()
    .references(() => queries.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  // The provider's own counts, not cl100k_base's estimate.
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  // tokens × LLM_COST_*_PER_MTOK. Configuration, not a price the API returned,
  // and blind to prompt caching.
  estimatedCost: numeric('estimated_cost', {
    precision: 12,
    scale: 6,
    mode: 'number',
  })
    .notNull()
    .default(0),
  abstained: boolean('abstained').notNull().default(false),
  abstainReason: abstainReason('abstain_reason'),
  /** `end_turn`, `length`, `truncated` … — whatever the provider reported. */
  finishReason: text('finish_reason'),
  citationsOffered: integer('citations_offered').notNull().default(0),
  citationsValid: integer('citations_valid').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
