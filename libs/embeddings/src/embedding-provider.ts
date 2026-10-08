/**
 * Voyage (and most embedding APIs) embed a passage and a question with
 * different internal prompts, so the same model returns better-aligned vectors
 * when told which side of the retrieval it is looking at. indexing-service
 * always sends `document`; retrieval-service (phase 4) sends `query`.
 */
export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingBatch {
  /** One vector per input text, in input order, each of `dimensions` length. */
  vectors: number[][];
  /** As counted by the provider's own tokenizer, or null when it reports none. */
  totalTokens: number | null;
}

/**
 * The one contract both sides of the search speak. A provider is constructed
 * once per process from `AppConfigService` (see `EmbeddingsModule`), so the
 * model and the dimension are fixed for the lifetime of the service — and the
 * dimension is fixed for the lifetime of the database (`vector(1024)`).
 */
export interface EmbeddingProvider {
  /** `voyage` | `fake` — what `EMBEDDING_PROVIDER` selected. */
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<EmbeddingBatch>;
}

/** Injection token for the configured `EmbeddingProvider`. */
export const EMBEDDINGS = Symbol('EMBEDDINGS');

export interface EmbeddingErrorDetails {
  /**
   * A retryable error (rate limit, outage, network) may succeed later and
   * must not mark the document as broken; a non-retryable one (bad request,
   * wrong key, a vector of the wrong size) will fail the same way every time.
   */
  retryable: boolean;
  /** HTTP status when the provider answered at all. */
  status?: number;
  /** The wait the provider asked for (`Retry-After`), in milliseconds. */
  retryAfterMs?: number;
}

/** Everything a provider throws, classified for the caller. */
export class EmbeddingError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: EmbeddingErrorDetails) {
    super(message);
    this.name = 'EmbeddingError';
    this.retryable = details.retryable;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
