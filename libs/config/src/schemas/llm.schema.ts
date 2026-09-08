import Joi from 'joi';

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const llmSchema = Joi.object({
  LLM_PROVIDER: Joi.string()
    .valid(...LLM_PROVIDERS)
    .default('ollama'),

  // Drizzle šema hardkoduje `vector(1024)` u libs/database/src/schema/chunks.ts, a
  // migracija 0001 je to zapečatila u bazi. Druga vrijednost ovdje bi značila da
  // embedding servis proizvodi vektore koje INSERT odbija — pa je zaključavamo.
  // Promjena dimenzije = izmjena šeme + nova migracija + reindeksiranje korpusa.
  EMBEDDING_DIMENSIONS: Joi.number().valid(1024).default(1024),
});
