/* oxlint-disable unicorn/no-thenable -- `then` is Joi's conditional branch, not a thenable */
import Joi from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';

export const EMBEDDING_PROVIDERS = ['voyage', 'fake'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * Composed by every service that turns text into vectors — indexing-service
 * (documents) and, retrieval-service (queries). The two must
 * agree on the model, which is why the model is configuration shared through
 * this fragment and not a constant inside one service.
 */
export const embeddingsSchema = Joi.object({
  // `fake` is a deterministic, network-free provider for tests and for a
  // laptop without an API key. Its vectors carry no meaning, so a production
  // environment must not be able to select it by accident. (`invalid`, not a
  // narrower `valid`: `when` merges the branch into the base schema, and a
  // merged `valid` list is the union of both.)
  EMBEDDING_PROVIDER: Joi.string()
    .valid(...EMBEDDING_PROVIDERS)
    .default('voyage')
    .when('NODE_ENV', {
      is: AppEnvironment.PRODUCTION,
      then: Joi.invalid('fake'),
    }),

  EMBEDDING_MODEL: Joi.string().default('voyage-law-2'),

  // The Drizzle schema hardcodes `vector(1024)` in
  // libs/database/src/schema/chunks.ts, and migration 0001 sealed that into the
  // database. Any other value here would mean the embedding provider produces
  // vectors that the UPDATE rejects — so it is locked. Changing the dimension
  // means a schema change, a new migration, and reindexing the whole corpus.
  EMBEDDING_DIMENSIONS: Joi.number().valid(1024).default(1024),

  // Joi validates a referenced sibling first, so the default above is in
  // place when this condition is evaluated: no provider set means Voyage,
  // and Voyage without a key fails at boot rather than at the first document.
  VOYAGE_API_KEY: Joi.string().when('EMBEDDING_PROVIDER', {
    is: 'voyage',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // Only for pointing the client at a stand-in of the API — the load tests'
  // stub. Unset means the real endpoint.
  VOYAGE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .empty(''),

  // Chunks per embedding request. Voyage accepts up to 1 000 texts and, for
  // voyage-law-2, 120K tokens per request; 100 chunks of at most 800 tokens
  // stay well inside both.
  EMBEDDING_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
});
