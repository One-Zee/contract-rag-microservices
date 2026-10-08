/**
 * The generation client, behind the same kind of interface as
 * `EmbeddingProvider` in `@app/embeddings` — but in this service rather than in
 * a lib, for the reason `Reranker` gives: exactly one service generates. The
 * embedding client is shared because indexing and retrieval must agree on a
 * model; nothing else in the system has an opinion about how an answer is
 * written.
 *
 * The shape differs from the other two clients in one way that matters: this
 * one streams. `stream()` returns an async iterable rather than a promise, so
 * the caller can forward each fragment the moment it arrives instead of
 * waiting for a complete answer nobody asked to wait for.
 */
export interface LlmRequest {
  /** The role and the rules — plan §8.3. */
  system: string;
  /** The context block and the question, as one user turn. */
  prompt: string;
  maxTokens: number;
  /** Omitted from the wire request when undefined: not every model accepts it. */
  temperature?: number;
}

/**
 * One event from the provider. `text` is the only kind the user sees; the
 * other two carry what the log needs and arrive at unpredictable points —
 * usage may be split across the start and end of a stream.
 */
export type LlmStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'stop'; reason: string };

export interface LlmProvider {
  /** `anthropic` | `ollama` | `fake` — what `LLM_PROVIDER` selected. */
  readonly name: string;
  readonly model: string;
  stream(
    request: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk>;
}

/** Injection token for the configured `LlmProvider`. */
export const LLM = Symbol('LLM');

export interface LlmErrorDetails {
  /**
   * A retryable error (rate limit, outage, network) may succeed a moment
   * later; a non-retryable one (bad request, wrong key, unknown model) fails
   * the same way every time.
   *
   * Retryability alone does not decide whether a retry happens: once a single
   * token has reached the user, replaying the request would duplicate text on
   * their screen, so the providers stop retrying at the first fragment
   * regardless of what this says.
   */
  retryable: boolean;
  /** HTTP status when the provider answered at all. */
  status?: number;
  /** The wait the provider asked for (`Retry-After`), in milliseconds. */
  retryAfterMs?: number;
}

/** Everything a provider throws, classified for the caller. */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: LlmErrorDetails) {
    super(message);
    this.name = 'LlmError';
    this.retryable = details.retryable;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
