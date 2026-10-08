/* oxlint-disable unicorn/no-thenable -- `then` is Joi's conditional branch, not a thenable */
import Joi from 'joi';

export const RERANK_PROVIDERS = ['cohere', 'none'] as const;
export type RerankProviderName = (typeof RERANK_PROVIDERS)[number];

export const LEXICAL_MATCHES = ['all', 'any'] as const;
export type LexicalMatch = (typeof LEXICAL_MATCHES)[number];

/**
 * The knobs of the hybrid search, composed by retrieval-service alone.
 *
 * They are configuration rather than constants because the experiment in plan
 * §9.2 compares configurations of the same pipeline: a measurement is only
 * honest if every run used the same values, and the only way to record which
 * values a run used is to have them written down somewhere.
 */
export const retrievalSchema = Joi.object({
  // Candidates per branch — the `LIMIT` of the vector query and of the lexical
  // query.
  SEARCH_CANDIDATES: Joi.number().integer().min(1).max(200).default(20),

  // Kept after RRF fusion, and the most a reranker is ever shown.
  //
  // The defaults are references rather than plain numbers because Joi applies
  // a default as-is, without re-checking it against the rules: a plain
  // `.default(10)` alongside `SEARCH_CANDIDATES=5` would pass validation and
  // claim a wider fusion window than either branch can fill. Refs do resolve
  // against a sibling's default, so the normal case is still 20 → 10 → 5.
  SEARCH_FUSED: Joi.number()
    .integer()
    .min(1)
    .max(Joi.ref('SEARCH_CANDIDATES'))
    .default(
      Joi.ref('SEARCH_CANDIDATES', {
        adjust: (candidates: number) => Math.min(10, candidates),
      }),
    ),

  // Returned when the caller names no limit of its own.
  SEARCH_TOP_K: Joi.number()
    .integer()
    .min(1)
    .max(Joi.ref('SEARCH_FUSED'))
    .default(
      Joi.ref('SEARCH_FUSED', {
        adjust: (fused: number) => Math.min(5, fused),
      }),
    ),

  // The constant of reciprocal rank fusion: score = Σ 1/(k + rank). A larger k
  // flattens the weight of the top positions, so a document has to place well
  // in both branches rather than first in one. 60 is the value from the
  // original RRF paper and the one the measurements assume.
  RRF_K: Joi.number().integer().min(1).default(60),

  // How many candidates the HNSW index visits before the filter is applied.
  // Under a narrow visibility filter a low value returns fewer rows than
  // `SEARCH_CANDIDATES` — the trade-off between latency and recall, and the
  // one number that must not drift between measurements.
  HNSW_EF_SEARCH: Joi.number().integer().min(1).default(100),

  // Whether the lexical branch needs every word of the question in a chunk
  // (`all`, the original behaviour) or any of them, ranked by frequency
  // (`any`). See search.repository.ts for why it matters.
  LEXICAL_MATCH: Joi.string()
    .valid(...LEXICAL_MATCHES)
    .default('all'),

  // `none` is the identity reranker: it keeps the RRF order and calls nothing.
  // It is the default so the stack runs without a second API key — reranking
  // improves an order that is already useful on its own.
  RERANK_PROVIDER: Joi.string()
    .valid(...RERANK_PROVIDERS)
    .default('none'),

  RERANK_MODEL: Joi.string().default('rerank-v3.5'),

  // Same shape as VOYAGE_API_KEY: required exactly when the provider that
  // needs it is selected, so a missing key fails at boot and names itself.
  COHERE_API_KEY: Joi.string().when('RERANK_PROVIDER', {
    is: 'cohere',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // A stand-in of the API for load tests, like VOYAGE_BASE_URL.
  COHERE_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .empty(''),
});
