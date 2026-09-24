/**
 * Reranking is the last step of the pipeline
 * a cross-encoder reads the question and each candidate *together*, which a
 * bi-encoder embedding cannot do, and reorders what fusion produced.
 *
 * It lives in this service rather than in a lib because exactly one service
 * reranks. The embedding client is shared (indexing embeds documents,
 * retrieval embeds questions, and they must agree on the model);
 * nothing else in the system has an opinion about candidate order.
 */
export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankedCandidate {
  id: string;
  /** Provider-specific relevance, only comparable inside one response. */
  score: number;
}

export interface Reranker {
  /** `cohere` | `none` — what `RERANK_PROVIDER` selected. */
  readonly name: string;
  /** The empty string when there is no model behind it. */
  readonly model: string;
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankedCandidate[]>;
}

/** Injection token for the configured `Reranker`. */
export const RERANKER = Symbol('RERANKER');

export interface RerankErrorDetails {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

/**
 * Same classification as `EmbeddingError`, but the caller treats it far more
 * gently: a failed reranking costs the ordering it would have improved, not
 * the answer.
 */
export class RerankError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: RerankErrorDetails) {
    super(message);
    this.name = 'RerankError';
    this.retryable = details.retryable;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
