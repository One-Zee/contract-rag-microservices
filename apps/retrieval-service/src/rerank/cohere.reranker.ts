import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import {
  RerankError,
  type RerankCandidate,
  type RerankedCandidate,
  type Reranker,
} from './reranker.js';

export const COHERE_BASE_URL = 'https://api.cohere.com/v2';
/** The API refuses a longer list; `SEARCH_FUSED` is far below it anyway. */
export const COHERE_MAX_DOCUMENTS = 1_000;

export interface CohereRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected by tests so a backoff test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CohereRerankerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injected by tests; defaults to the global `fetch` (Node ≥ 18). */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retry?: CohereRetryOptions;
}

interface CohereRerankResponse {
  results?: { index?: unknown; relevance_score?: unknown }[];
  meta?: { billed_units?: { search_units?: unknown } };
}

// Shorter than the embedding timeout: this call sits inside a request a person
// is waiting on, and its result is an improvement, not the answer.
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
const ERROR_BODY_MAX = 200;

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
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      return parsed.message.slice(0, ERROR_BODY_MAX);
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
 * Cohere Rerank over the REST API with the global `fetch` — same reasoning as
 * the Voyage client: one POST, and the parts worth writing (timeout, retry,
 * shape check) are not what an SDK would remove.
 *
 * Results come back as positions into the list that was sent, so the ids are
 * restored by index here; the caller never has to keep the order in mind.
 */
export class CohereReranker implements Reranker {
  readonly name = 'cohere';
  readonly model: string;

  private readonly logger = new Logger(CohereReranker.name);
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CohereRerankerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = `${options.baseUrl ?? COHERE_BASE_URL}/rerank`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = options.retry?.attempts ?? DEFAULT_ATTEMPTS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep = options.retry?.sleep ?? ((ms) => sleep(ms));
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankedCandidate[]> {
    if (candidates.length === 0 || topN <= 0) {
      return [];
    }
    if (candidates.length > COHERE_MAX_DOCUMENTS) {
      throw new RerankError(
        `Cohere accepts at most ${COHERE_MAX_DOCUMENTS} documents per request, got ${candidates.length}`,
        { retryable: false },
      );
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request(query, candidates, topN);
      } catch (error) {
        if (
          !(error instanceof RerankError) ||
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
    query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankedCandidate[]> {
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
          model: this.model,
          query,
          documents: candidates.map((candidate) => candidate.text),
          top_n: Math.min(topN, candidates.length),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RerankError(`Cohere request failed: ${reason}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      const detail = await describeBody(response);
      const retryable = RETRYABLE_STATUSES.has(response.status);
      throw new RerankError(
        `Cohere responded ${response.status}${detail ? `: ${detail}` : ''}`,
        {
          retryable,
          status: response.status,
          retryAfterMs: retryable
            ? parseRetryAfter(response.headers.get('retry-after'))
            : undefined,
        },
      );
    }

    return this.parse((await response.json()) as unknown, candidates);
  }

  private parse(
    body: unknown,
    candidates: RerankCandidate[],
  ): RerankedCandidate[] {
    const { results, meta } = (
      isRecord(body) ? body : {}
    ) as CohereRerankResponse;
    if (!Array.isArray(results)) {
      throw new RerankError('Cohere returned no results array', {
        retryable: false,
      });
    }

    const reranked = results.map(({ index, relevance_score: score }) => {
      if (
        typeof index !== 'number' ||
        index < 0 ||
        index >= candidates.length ||
        typeof score !== 'number'
      ) {
        throw new RerankError('Cohere returned a malformed result', {
          retryable: false,
        });
      }
      return { id: candidates[index].id, score };
    });

    // What the request cost, in the unit the bill is written in (plan §9.6).
    const searchUnits = meta?.billed_units?.search_units;
    if (typeof searchUnits === 'number') {
      this.logger.debug(
        `Reranked ${candidates.length} candidates (${searchUnits} search units)`,
      );
    }
    // The API returns them sorted, but the caller's order is the answer's
    // order — sorting here makes that true regardless.
    return reranked.sort((a, b) => b.score - a.score);
  }

  /** Exponential backoff with jitter, unless the server named its own wait. */
  private delayBefore(attempt: number, error: RerankError): number {
    if (error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, this.maxDelayMs);
    }
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.baseDelayMs * 0.25;
    return Math.min(exponential + jitter, this.maxDelayMs);
  }
}
