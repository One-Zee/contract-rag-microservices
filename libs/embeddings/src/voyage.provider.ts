import { setTimeout as sleep } from 'node:timers/promises';
import {
  EmbeddingError,
  type EmbeddingBatch,
  type EmbeddingInputType,
  type EmbeddingProvider,
} from './embedding-provider.js';

export const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';
/** The API rejects a longer list outright; `EMBEDDING_BATCH_SIZE` is capped to match. */
export const VOYAGE_MAX_TEXTS_PER_REQUEST = 1_000;

export interface VoyageRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  /** Also caps a `Retry-After` the server asks for. */
  maxDelayMs?: number;
  /** Injected by tests so a backoff test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface VoyageProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  /** Injected by tests; defaults to the global `fetch` (Node ≥ 18). */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retry?: VoyageRetryOptions;
}

interface VoyageEmbeddingsResponse {
  data?: { embedding?: unknown; index?: unknown }[];
  usage?: { total_tokens?: unknown };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const ERROR_BODY_MAX = 200;

/** 429 and 5xx are the documented "try again" answers; 408 is a timeout at their edge. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** What the body says, without trusting it to be JSON — never the request, so never the key. */
const describeBody = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.detail === 'string') {
      return parsed.detail.slice(0, ERROR_BODY_MAX);
    }
  } catch {
    // not JSON — the raw text will do
  }
  return text.slice(0, ERROR_BODY_MAX);
};

/** `Retry-After` is either seconds or an HTTP date; anything else is ignored. */
const parseRetryAfter = (header: string | null): number | undefined => {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

/**
 * `voyage-law-2` over the REST API with the global `fetch` — one POST, one
 * JSON body, so a client library would add a dependency without removing any
 * of the code below: the retry policy, the timeout and the shape check are the
 * parts that matter, and they are ours either way.
 *
 * Retries follow the API's own guidance (exponential backoff on 429) and
 * extend it to outages and network errors; anything else the API refuses is
 * reported once, as non-retryable. Every vector is checked against
 * `dimensions` before it is returned: a model that silently answers with
 * another size must fail here, not as a Postgres error per row.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VoyageProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.endpoint = `${options.baseUrl ?? VOYAGE_BASE_URL}/embeddings`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = options.retry?.attempts ?? DEFAULT_ATTEMPTS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep = options.retry?.sleep ?? ((ms) => sleep(ms));
  }

  async embed(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<EmbeddingBatch> {
    if (texts.length === 0) {
      return { vectors: [], totalTokens: 0 };
    }
    if (texts.length > VOYAGE_MAX_TEXTS_PER_REQUEST) {
      throw new EmbeddingError(
        `Voyage accepts at most ${VOYAGE_MAX_TEXTS_PER_REQUEST} texts per request, got ${texts.length}`,
        { retryable: false },
      );
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request(texts, inputType);
      } catch (error) {
        if (
          !(error instanceof EmbeddingError) ||
          !error.retryable ||
          attempt >= this.attempts
        ) {
          throw error;
        }
        await this.sleep(this.delayBefore(attempt, error));
      }
    }
  }

  private async request(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<EmbeddingBatch> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          input_type: inputType,
          // Chunks are far below the model's context, so this never triggers
          // for them; it keeps an oversized query (phase 4) from being a 400.
          truncation: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // fetch itself failed: DNS, refused connection, reset, or our timeout.
      // The request may well succeed a moment later.
      const reason = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(`Voyage request failed: ${reason}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      const detail = await describeBody(response);
      const retryable = RETRYABLE_STATUSES.has(response.status);
      throw new EmbeddingError(
        `Voyage responded ${response.status}${detail ? `: ${detail}` : ''}`,
        {
          retryable,
          status: response.status,
          retryAfterMs: retryable
            ? parseRetryAfter(response.headers.get('retry-after'))
            : undefined,
        },
      );
    }

    return this.parse((await response.json()) as unknown, texts.length);
  }

  private parse(body: unknown, expected: number): EmbeddingBatch {
    const { data, usage } = (
      isRecord(body) ? body : {}
    ) as VoyageEmbeddingsResponse;
    if (!Array.isArray(data) || data.length !== expected) {
      throw new EmbeddingError(
        `Voyage returned ${Array.isArray(data) ? data.length : 'no'} embeddings for ${expected} texts`,
        { retryable: false },
      );
    }

    // Placed by `index`, not by position: the API documents the order, but
    // a vector under the wrong chunk would be a silent retrieval bug.
    const vectors: (number[] | undefined)[] = Array.from({ length: expected });
    for (const item of data) {
      const { index, embedding } = item;
      if (
        typeof index !== 'number' ||
        index < 0 ||
        index >= expected ||
        vectors[index] !== undefined ||
        !Array.isArray(embedding)
      ) {
        throw new EmbeddingError('Voyage returned a malformed embedding list', {
          retryable: false,
        });
      }
      if (embedding.length !== this.dimensions) {
        throw new EmbeddingError(
          `Voyage returned a ${embedding.length}-dimensional vector, the database holds vector(${this.dimensions})`,
          { retryable: false },
        );
      }
      vectors[index] = embedding as number[];
    }

    const totalTokens = usage?.total_tokens;
    return {
      // Every slot is filled: `data.length === expected` and no index repeats.
      vectors: vectors as number[][],
      totalTokens: typeof totalTokens === 'number' ? totalTokens : null,
    };
  }

  /** Exponential backoff with jitter, unless the server named its own wait. */
  private delayBefore(attempt: number, error: EmbeddingError): number {
    if (error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, this.maxDelayMs);
    }
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.baseDelayMs * 0.25;
    return Math.min(exponential + jitter, this.maxDelayMs);
  }
}
