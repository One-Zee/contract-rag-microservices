import Joi from 'joi';

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const llmSchema = Joi.object({
  LLM_PROVIDER: Joi.string()
    .valid(...LLM_PROVIDERS)
    .default('ollama'),

  // The Drizzle schema hardcodes `vector(1024)` in
  // libs/database/src/schema/chunks.ts, and migration 0001 sealed that into the
  // database. Any other value here would mean the embedding service produces
  // vectors that INSERT rejects — so it is locked. Changing the dimension means
  // a schema change, a new migration, and reindexing the whole corpus.
  EMBEDDING_DIMENSIONS: Joi.number().valid(1024).default(1024),
});
