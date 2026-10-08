import { setTimeout as sleep } from 'node:timers/promises';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamChunk,
} from './llm-provider.js';
import { idleAbort, iterateJsonLines } from './stream-parser.js';

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const ERROR_BODY_MAX = 200;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  idleTimeoutMs?: number;
  retry?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const describeBody = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return parsed.error.slice(0, ERROR_BODY_MAX);
    }
  } catch {
    // not JSON — the raw text will do
  }
  return text.slice(0, ERROR_BODY_MAX);
};

/**
 * A local model through Ollama's chat endpoint — the zero-cost, zero-key path,
 * and the reason `LLM_PROVIDER` defaults to it.
 *
 * `/api/chat`, not `/api/generate`: the chat endpoint takes a system message as
 * a message and returns `message.content`, which keeps the prompt shape
 * identical to Anthropic's. Its body is NDJSON rather than SSE — one JSON
 * object per line, no `data:` prefix — so it shares the idle timeout and the
 * retry policy with the Anthropic client but not the framing.
 *
 * No authentication: Ollama listens on localhost and has none. That is also
 * why `OLLAMA_BASE_URL` is validated as a URL and nothing else.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;

  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly idleTimeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/api/chat`;
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
        if (!retryable || emitted) {
          throw error;
        }
        await this.sleep(this.delayBefore(attempt));
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
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          options: {
            num_predict: request.maxTokens,
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
          },
        }),
        signal: idle.signal,
      });

      if (!response.ok) {
        const detail = await describeBody(response);
        throw new LlmError(
          `Ollama responded ${response.status}${detail ? `: ${detail}` : ''}`,
          {
            retryable: RETRYABLE_STATUSES.has(response.status),
            status: response.status,
          },
        );
      }
      if (!response.body) {
        throw new LlmError('Ollama returned no response body', {
          retryable: true,
        });
      }

      for await (const line of iterateJsonLines(response.body)) {
        idle.touch();
        yield* interpret(line);
      }
    } catch (error) {
      throw asLlmError(error, idle.signal);
    } finally {
      idle.dispose();
    }
  }

  private delayBefore(attempt: number): number {
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.maxDelayMs);
  }
}

interface OllamaLine {
  message?: { content?: unknown };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

function* interpret(line: string): Generator<LlmStreamChunk> {
  let parsed: OllamaLine;
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) {
      return;
    }
    parsed = value as OllamaLine;
  } catch {
    throw new LlmError('Ollama sent a line that is not JSON', {
      retryable: false,
    });
  }

  // Ollama can report a failure mid-stream as a line rather than a status.
  if (typeof parsed.error === 'string') {
    throw new LlmError(`Ollama streamed an error: ${parsed.error}`, {
      retryable: false,
    });
  }

  const content = parsed.message?.content;
  if (typeof content === 'string' && content.length > 0) {
    yield { type: 'text', text: content };
  }

  if (parsed.done !== true) {
    return;
  }

  // The final line carries the counts. `prompt_eval_count` can be absent when
  // the prompt was served from cache, so neither is assumed present.
  const inputTokens = parsed.prompt_eval_count;
  const outputTokens = parsed.eval_count;
  if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
    yield {
      type: 'usage',
      ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
      ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
    };
  }
  yield {
    type: 'stop',
    reason:
      typeof parsed.done_reason === 'string' ? parsed.done_reason : 'stop',
  };
}

const asLlmError = (error: unknown, signal: AbortSignal): LlmError => {
  if (error instanceof LlmError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  const isIdle =
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError';

  if (isIdle) {
    return new LlmError(`Ollama stream went silent: ${reason}`, {
      retryable: true,
    });
  }
  if (signal.aborted) {
    return new LlmError('Ollama request was cancelled', { retryable: false });
  }
  // Nearly always "daemon not running" in development, which is exactly the
  // failure the default provider trades a key for.
  return new LlmError(`Ollama request failed: ${reason}`, { retryable: true });
};
