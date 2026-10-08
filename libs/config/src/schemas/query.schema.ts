import Joi from 'joi';

/**
 * How a question becomes a prompt — llm-service's alone.
 *
 * Separate from `llmSchema` because these knobs describe the pipeline, not the
 * model: they would still exist if the model were swapped for a lookup table.
 * Separate from `retrievalSchema` because that fragment belongs to
 * retrieval-service, and llm-service is its client, not its owner — it asks
 * for `QUERY_CONTEXT_CHUNKS` and takes whatever number comes back.
 */
export const querySchema = Joi.object({
  QUERY_CONTEXT_CHUNKS: Joi.number().integer().min(1).max(20).default(5),

  QUERY_MIN_SIMILARITY: Joi.number().min(0).max(1).default(0),

  // Budget for the context block alone, counted with cl100k_base (ADR 009) —
  // an approximation, since that is neither Claude's tokenizer nor Llama's.
  // The authoritative counts come back from the provider and are what
  // `answers.tokens_in` stores.
  QUERY_CONTEXT_MAX_TOKENS: Joi.number().integer().min(500).default(6000),

  QUERY_HISTORY_PAGE_SIZE: Joi.number().integer().min(1).max(100).default(20),
});
