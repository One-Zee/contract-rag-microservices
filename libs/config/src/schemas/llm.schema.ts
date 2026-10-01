/* oxlint-disable unicorn/no-thenable -- `then` is Joi's conditional branch, not a thenable */
import Joi from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';

export const LLM_PROVIDERS = ['anthropic', 'ollama', 'fake'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Per-provider defaults, so switching `LLM_PROVIDER` does not also need a model. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  ollama: 'llama3.1:8b',
  fake: 'fake-legal-assistant',
};

/**
 * The generation side of the AI layer. Embeddings have their own fragment,
 * `embeddingsSchema`: indexing-service embeds without ever calling an LLM, and
 * llm-service answers without ever embedding.
 *
 * `ollama` is the default because it needs no key — the same reasoning that
 * makes `RERANK_PROVIDER=none` the default. It does need a local daemon, which
 * is a failure at the first question rather than at boot; that is the price of
 * a default that lets the repo be cloned and run.
 */
export const llmSchema = Joi.object({
  // `fake` is deterministic and network-free, for tests and for a laptop with
  // no key and no daemon. Its answers carry no meaning, so production must not
  // be able to select it by accident. (`invalid`, not a narrower `valid`:
  // `when` merges the branch into the base, and a merged `valid` list is the
  // union of both.)
  LLM_PROVIDER: Joi.string()
    .valid(...LLM_PROVIDERS)
    .default('ollama')
    .when('NODE_ENV', {
      is: AppEnvironment.PRODUCTION,
      then: Joi.invalid('fake'),
    }),

  // Joi validates the referenced sibling first, so the default above is in
  // place by the time this is evaluated.
  LLM_MODEL: Joi.string().when('LLM_PROVIDER', {
    switch: (Object.keys(DEFAULT_MODELS) as LlmProvider[]).map((provider) => ({
      is: provider,
      then: Joi.string().default(DEFAULT_MODELS[provider]),
    })),
  }),

  // Same shape as VOYAGE_API_KEY and COHERE_API_KEY: required exactly when the
  // provider that needs it is selected, so a missing key fails at boot and
  // names itself.
  ANTHROPIC_API_KEY: Joi.string().when('LLM_PROVIDER', {
    is: 'anthropic',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  /** Anthropic pins its wire format to a date header rather than a URL path. */
  ANTHROPIC_VERSION: Joi.string().default('2023-06-01'),

  OLLAMA_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:11434'),

  LLM_MAX_TOKENS: Joi.number().integer().min(1).max(8192).default(1024),

  // Deliberately no default: not every model accepts the parameter, so an
  // unset value means "do not send the field" rather than "send zero". Phase 7
  // sets it explicitly and records the value, the way HNSW_EF_SEARCH is
  // recorded — a measurement is only comparable if this was the same.
  LLM_TEMPERATURE: Joi.number().min(0).max(2).optional(),

  // Not a total timeout: a long answer is not a hung one. The providers reset
  // this on every chunk and abort only after this much silence.
  LLM_IDLE_TIMEOUT_MS: Joi.number().integer().min(1000).default(60_000),

  // Prices per million tokens, used only to fill `answers.estimated_cost`.
  // The API does not return a price and prices change, so this is declared
  // rather than hardcoded — and a wrong number here is a wrong column, never a
  // wrong answer. Zero for a local model.
  LLM_COST_INPUT_PER_MTOK: Joi.number().min(0).default(0),
  LLM_COST_OUTPUT_PER_MTOK: Joi.number().min(0).default(0),
});
