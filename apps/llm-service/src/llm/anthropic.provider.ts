import { setTimeout as sleep } from 'node:timers/promises';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamChunk,
} from './llm-provider.js';
import { idleAbort, iterateSseData } from './stream-parser.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const ERROR_BODY_MAX = 200;

/** 429 and 5xx are the documented "try again" answers; 408 is a timeout at their edge. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/** Error types Anthropic marks as transient in a `data: {"type":"error"}` frame. */
const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
]);

export interface AnthropicRetryOptions {
  /** Total attempts, including the first. Only ever spent before the first token. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected by tests so a backoff test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** The dated wire-format header; Anthropic versions by header, not by path. */
  version: string;
  baseUrl?: string;
  /** Injected by tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Silence, not total duration. */
  idleTimeoutMs?: number;
  retry?: AnthropicRetryOptions;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** What the body says, without trusting it to be JSON — never the request, so never the key. */
const describeBody = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const { message } = parsed.error;
      if (typeof message === 'string') {
        return message.slice(0, ERROR_BODY_MAX);
      }
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
 * Claude over the Messages API with the global `fetch` — one POST, one SSE
 * body, so an SDK would add a dependency without removing any of the code
 * below: the retry policy, the idle timeout and the block-type filter are the
 * parts that matter, and they are ours either way. The same argument
 * `VoyageEmbeddingProvider` makes.
 *
 * Two deliberate differences from that template:
 *
 *  - the timeout is on *silence*, not on the request: a thorough answer is
 *    slow by nature and must not be truncated for being thorough;
 *  - retries stop at the first fragment of text. Replaying a request whose
 *    output has already reached the user would print the beginning twice,
 *    which is worse than the error it was trying to avoid.
 *
 * Note the auth header: `x-api-key`, not `Authorization: Bearer` as Voyage and
 * Cohere use. It goes on the phase-6 redaction list with them.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;

  private readonly apiKey: string;
  private readonly version: string;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly idleTimeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.version = options.version;
    this.endpoint = `${options.baseUrl ?? ANTHROPIC_BASE_URL}/v1/messages`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.attempts = options.retry?.attempts ?? DEFAULT_ATTEMPTS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep = options.retry?.sleep ?? ((ms) => sleep(ms));
  }

  async *stream(
    request: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        for await (const chunk of this.attempt(request, signal)) {
          emitted ||= chunk.type === 'text';
          yield chunk;
        }
        return;
      } catch (error) {
        const retryable =
          error instanceof LlmError &&
          error.retryable &&
          attempt < this.attempts;
        // The point of no return: once the user has seen text, a replay would
        // duplicate it.
        if (!retryable || emitted) {
          throw error;
        }
        await this.sleep(this.delayBefore(attempt, error));
      }
    }
  }

  private async *attempt(
    request: LlmRequest,
    external?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    const idle = idleAbort(this.idleTimeoutMs, external);
    idle.touch();

    try {
      const response = await this.post(request, idle.signal);

      if (!response.ok) {
        const detail = await describeBody(response);
        const retryable = RETRYABLE_STATUSES.has(response.status);
        throw new LlmError(
          `Anthropic responded ${response.status}${detail ? `: ${detail}` : ''}`,
          {
            retryable,
            status: response.status,
            retryAfterMs: retryable
              ? parseRetryAfter(response.headers.get('retry-after'))
              : undefined,
          },
        );
      }
      if (!response.body) {
        throw new LlmError('Anthropic returned no response body', {
          retryable: true,
        });
      }

      // Which content block each index is. Opus-class models emit a `thinking`
      // block before the answer; forwarding its deltas would stream reasoning
      // to the user as though it were the answer, and would move the
      // time-to-first-token that §9.4 measures onto the wrong thing.
      const blockTypes = new Map<number, string>();

      for await (const data of iterateSseData(response.body)) {
        idle.touch();
        const event = parseEvent(data);
        if (!event) {
          continue;
        }
        yield* interpret(event, blockTypes);
      }
    } catch (error) {
      throw asLlmError(error, idle.signal);
    } finally {
      idle.dispose();
    }
  }

  private post(request: LlmRequest, signal: AbortSignal): Promise<Response> {
    return this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        stream: true,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        // Omitted entirely when unset: not every model accepts the field, and
        // sending 0 "to be safe" is how a model swap turns into a 400.
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
      }),
      signal,
    });
  }

  /** Exponential backoff with jitter, unless the server named its own wait. */
  private delayBefore(attempt: number, error: LlmError): number {
    if (error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, this.maxDelayMs);
    }
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.baseDelayMs * 0.25;
    return Math.min(exponential + jitter, this.maxDelayMs);
  }
}

interface AnthropicEvent {
  type?: unknown;
  index?: unknown;
  content_block?: { type?: unknown };
  delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
  message?: { usage?: { input_tokens?: unknown } };
  usage?: { output_tokens?: unknown };
  error?: { type?: unknown; message?: unknown };
}

const parseEvent = (data: string): AnthropicEvent | null => {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? (parsed as AnthropicEvent) : null;
  } catch {
    throw new LlmError('Anthropic sent a frame that is not JSON', {
      retryable: false,
    });
  }
};

function* interpret(
  event: AnthropicEvent,
  blockTypes: Map<number, string>,
): Generator<LlmStreamChunk> {
  switch (event.type) {
    case 'message_start': {
      const input = event.message?.usage?.input_tokens;
      if (typeof input === 'number') {
        yield { type: 'usage', inputTokens: input };
      }
      return;
    }
    case 'content_block_start': {
      if (typeof event.index === 'number') {
        const blockType = event.content_block?.type;
        blockTypes.set(
          event.index,
          typeof blockType === 'string' ? blockType : 'unknown',
        );
      }
      return;
    }
    case 'content_block_delta': {
      const index = typeof event.index === 'number' ? event.index : 0;
      // Both conditions matter: `thinking` blocks carry `thinking_delta`, but
      // a future block type could carry `text_delta` and still not be answer
      // text.
      if (
        blockTypes.get(index) === 'text' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        yield { type: 'text', text: event.delta.text };
      }
      return;
    }
    case 'content_block_stop': {
      if (typeof event.index === 'number') {
        blockTypes.delete(event.index);
      }
      return;
    }
    case 'message_delta': {
      // Take the last one seen rather than summing: the field is the running
      // total for the message, so adding them up would over-count.
      const output = event.usage?.output_tokens;
      if (typeof output === 'number') {
        yield { type: 'usage', outputTokens: output };
      }
      const reason = event.delta?.stop_reason;
      if (typeof reason === 'string') {
        yield { type: 'stop', reason };
      }
      return;
    }
    case 'error': {
      const kind =
        typeof event.error?.type === 'string' ? event.error.type : '';
      const message =
        typeof event.error?.message === 'string'
          ? event.error.message
          : 'unspecified error';
      throw new LlmError(`Anthropic streamed an error: ${message}`, {
        retryable: RETRYABLE_ERROR_TYPES.has(kind),
      });
    }
    default:
      // `ping`, `message_stop`, and anything added to the protocol later.
      return;
  }
}

/** Classifies what `fetch` and the body reader throw, including our own aborts. */
const asLlmError = (error: unknown, signal: AbortSignal): LlmError => {
  if (error instanceof LlmError) {
    return error;
  }
  const aborted = signal.aborted;
  const reason = error instanceof Error ? error.message : String(error);
  const isIdle =
    aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError';

  if (isIdle) {
    return new LlmError(`Anthropic stream went silent: ${reason}`, {
      retryable: true,
    });
  }
  if (aborted) {
    // The caller gave up, or the client disconnected. Not a provider fault,
    // and never worth retrying.
    return new LlmError('Anthropic request was cancelled', {
      retryable: false,
    });
  }
  return new LlmError(`Anthropic request failed: ${reason}`, {
    retryable: true,
  });
};
