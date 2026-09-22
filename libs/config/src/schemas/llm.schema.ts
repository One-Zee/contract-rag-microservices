import Joi from 'joi';

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The generation side of the AI layer. Embeddings have their own
 * fragment, `embeddingsSchema`: indexing-service embeds without ever calling
 * an LLM, and llm-service answers without ever embedding.
 */
export const llmSchema = Joi.object({
  LLM_PROVIDER: Joi.string()
    .valid(...LLM_PROVIDERS)
    .default('ollama'),
});
