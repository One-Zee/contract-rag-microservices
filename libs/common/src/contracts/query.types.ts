/**
 * The vocabulary of the answer pipeline, shared by llm-service (which produces
 * these values), the gateway (which forwards them) and the database enums in
 * `@app/database` (which store them). The schema specs assert that the three
 * agree — a value added here and forgotten in the migration is a runtime
 * insert failure, not a type error.
 */

/**
 * What arrives over the SSE stream, in order: exactly one `meta`, then zero or
 * more `token`, then exactly one `done` — unless generation broke after it had
 * already started, in which case an `error` takes the place of `done`.
 *
 * A failure *before* the first `meta` never reaches this union: it is still a
 * real HTTP status, because the gateway awaits that first event before handing
 * the stream to Nest.
 */
export const QUERY_EVENT_TYPES = ['meta', 'token', 'done', 'error'] as const;
export type QueryEventType = (typeof QUERY_EVENT_TYPES)[number];

/**
 * Why the system declined to answer. The first two are decided before the model is called and cost
 * nothing; the last two are only knowable afterwards.
 */
export const ABSTAIN_REASONS = [
  /** Retrieval returned no chunk at all — nothing visible matched. */
  'no_context',
  /** Chunks came back, but none reached `QUERY_MIN_SIMILARITY`. */
  'below_threshold',
  /** The model answered, but cited nothing that was in the context. */
  'no_citations',
  /** The model replied with the abstention sentence, whatever it cited besides. */
  'declined',
] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

/**
 * How a logged query ended. `abandoned` exists because the client can walk
 * away mid-answer: the TCP transport carries no cancellation, so that case is
 * only distinguishable if it is recorded.
 */
export const QUERY_STATUSES = [
  'answered',
  'abstained',
  'failed',
  'abandoned',
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];
