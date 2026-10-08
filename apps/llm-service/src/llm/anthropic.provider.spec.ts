import { Logger } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider.js';
import { LlmError, type LlmStreamChunk } from './llm-provider.js';

Logger.overrideLogger(false);

const encoder = new TextEncoder();

/** An SSE body built from whole frames, or from raw pieces when a split matters. */
const sseBody = (...pieces: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });

const frame = (payload: object): string =>
  `event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`;

const okStream = (...payloads: object[]): Response =>
  new Response(sseBody(...payloads.map((p) => frame(p))), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

/** The usual, well-behaved sequence. */
const HAPPY = [
  { type: 'message_start', message: { usage: { input_tokens: 812 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Ninety ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'days. [1]' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 12 },
  },
  { type: 'message_stop' },
];

const request = {
  system: 'You are a legal assistant.',
  prompt: '[1] Either party may terminate…\n\nHow much notice?',
  maxTokens: 1024,
};

const drain = async (
  source: AsyncIterable<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> => {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
};

const textOf = (chunks: LlmStreamChunk[]): string =>
  chunks
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

const provider = (
  fetchStub: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) =>
  new AnthropicProvider({
    apiKey: 'sk-ant-secret-key',
    model: 'claude-haiku-4-5',
    version: '2023-06-01',
    fetch: fetchStub,
    retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
    ...overrides,
  });

describe('AnthropicProvider', () => {
  it('posts a streaming request with the key in x-api-key and the dated version header', async () => {
    const fetchStub = vi.fn().mockResolvedValue(okStream(...HAPPY));

    await drain(provider(fetchStub).stream(request));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-secret-key');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers.authorization).toBeUndefined();

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5',
      stream: true,
      max_tokens: 1024,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    });
  });

  // Not every model accepts the parameter, so an unset temperature has to mean
  // "leave the field out" rather than "send zero".
  it('omits temperature when it is unset and sends it when it is not', async () => {
    const fetchStub = vi.fn().mockResolvedValue(okStream(...HAPPY));
    await drain(provider(fetchStub).stream(request));
    expect(JSON.parse(fetchStub.mock.calls[0][1].body)).not.toHaveProperty(
      'temperature',
    );

    const withTemp = vi.fn().mockResolvedValue(okStream(...HAPPY));
    await drain(provider(withTemp).stream({ ...request, temperature: 0 }));
    expect(JSON.parse(withTemp.mock.calls[0][1].body).temperature).toBe(0);
  });

  it('streams the text deltas and reports usage and stop reason', async () => {
    const fetchStub = vi.fn().mockResolvedValue(okStream(...HAPPY));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(textOf(chunks)).toBe('Ninety days. [1]');
    expect(chunks).toContainEqual({ type: 'usage', inputTokens: 812 });
    expect(chunks).toContainEqual({ type: 'usage', outputTokens: 12 });
    expect(chunks).toContainEqual({ type: 'stop', reason: 'end_turn' });
  });

  // Opus-class models emit a thinking block first. Forwarding its deltas would
  // stream reasoning to the user as though it were the answer.
  it('does not emit thinking deltas as answer text', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      okStream(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me check clause 9…' },
        },
        // A future block type could even carry a text_delta; still not answer text.
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'reasoning leak' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Ninety days. [1]' },
        },
        { type: 'message_stop' },
      ),
    );

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(textOf(chunks)).toBe('Ninety days. [1]');
    expect(textOf(chunks)).not.toContain('reasoning leak');
  });

  it('retries a 429 that happens before any text, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"slow down"}}', {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      )
      .mockResolvedValueOnce(okStream(...HAPPY));

    const chunks = await drain(
      provider(fetchStub, {
        retry: {
          attempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 5_000,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      }).stream(request),
    );

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
    expect(textOf(chunks)).toBe('Ninety days. [1]');
  });

  // Replaying a request whose output the user has already read would print the
  // beginning of the answer twice — worse than the error it avoids.
  it('never retries a stream that has already emitted text', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      okStream(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Ninety days.' },
        },
        {
          type: 'error',
          error: { type: 'overloaded_error', message: 'overloaded' },
        },
      ),
    );

    const chunks: LlmStreamChunk[] = [];
    const failure = await drain(
      (async function* () {
        yield* provider(fetchStub).stream(request);
      })(),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).retryable).toBe(true);
    expect(chunks).toEqual([]);
  });

  it('does not retry a 400 and keeps the key out of the message', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response('{"error":{"message":"max_tokens: must be >= 1"}}', {
        status: 400,
      }),
    );

    const failure = await drain(provider(fetchStub).stream(request)).then(
      () => null,
      (error: unknown) => error as LlmError,
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(failure!.retryable).toBe(false);
    expect(failure!.status).toBe(400);
    expect(failure!.message).toContain('max_tokens');
    expect(failure!.message).not.toContain('sk-ant-secret-key');
  });

  it('classifies a streamed overloaded_error as retryable', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        okStream({
          type: 'error',
          error: { type: 'overloaded_error', message: 'overloaded' },
        }),
      )
      .mockResolvedValueOnce(okStream(...HAPPY));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(textOf(chunks)).toBe('Ninety days. [1]');
  });

  it('treats a network failure as retryable and a cancellation as not', async () => {
    const network = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okStream(...HAPPY));
    expect(textOf(await drain(provider(network).stream(request)))).toBe(
      'Ninety days. [1]',
    );

    const cancelled = vi.fn().mockImplementation(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const controller = new AbortController();
    controller.abort(new Error('client left'));

    const failure = await drain(
      provider(cancelled).stream(request, controller.signal),
    ).then(
      () => null,
      (error: unknown) => error as LlmError,
    );

    expect(failure!.retryable).toBe(false);
    expect(failure!.message).toContain('cancelled');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('aborts a stream that goes silent, and reports it as retryable', async () => {
    const fetchStub = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason);
          });
        }),
    );

    const failure = await drain(
      provider(fetchStub, {
        idleTimeoutMs: 20,
        retry: { attempts: 1, baseDelayMs: 1, sleep: async () => {} },
      }).stream(request),
    ).then(
      () => null,
      (error: unknown) => error as LlmError,
    );

    expect(failure!.retryable).toBe(true);
    expect(failure!.message).toContain('silent');
  });
});
