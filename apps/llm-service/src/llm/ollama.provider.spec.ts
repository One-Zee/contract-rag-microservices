import { Logger } from '@nestjs/common';
import type { LlmError, LlmStreamChunk } from './llm-provider.js';
import { OllamaProvider } from './ollama.provider.js';

Logger.overrideLogger(false);

const encoder = new TextEncoder();

const ndjsonBody = (...pieces: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });

const ok = (...pieces: string[]): Response =>
  new Response(ndjsonBody(...pieces), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });

const say = (content: string) =>
  `${JSON.stringify({ model: 'llama3.1:8b', message: { role: 'assistant', content }, done: false })}\n`;

const DONE = `${JSON.stringify({
  model: 'llama3.1:8b',
  message: { role: 'assistant', content: '' },
  done_reason: 'stop',
  done: true,
  prompt_eval_count: 812,
  eval_count: 12,
})}\n`;

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

const provider = (fetchStub: typeof globalThis.fetch) =>
  new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3.1:8b',
    fetch: fetchStub,
    retry: { attempts: 2, baseDelayMs: 1, sleep: async () => {} },
  });

describe('OllamaProvider', () => {
  it('posts to /api/chat with the system turn as a message and no auth header', async () => {
    const fetchStub = vi.fn().mockResolvedValue(ok(say('Ninety days.'), DONE));

    await drain(provider(fetchStub).stream(request));

    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'llama3.1:8b',
      stream: true,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      options: { num_predict: 1024 },
    });
  });

  it('accumulates content across lines split over chunk boundaries', async () => {
    const lines = say('Ninety ') + say('days. [1]') + DONE;
    const cut = Math.floor(lines.length / 2);
    const fetchStub = vi
      .fn()
      .mockResolvedValue(ok(lines.slice(0, cut), lines.slice(cut)));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(textOf(chunks)).toBe('Ninety days. [1]');
  });

  it('reads the token counts and the stop reason off the final line', async () => {
    const fetchStub = vi.fn().mockResolvedValue(ok(say('Ninety days.'), DONE));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(chunks).toContainEqual({
      type: 'usage',
      inputTokens: 812,
      outputTokens: 12,
    });
    expect(chunks).toContainEqual({ type: 'stop', reason: 'stop' });
  });

  // `prompt_eval_count` is absent when the prompt came from cache.
  it('tolerates a final line with no prompt_eval_count', async () => {
    const done = `${JSON.stringify({ done: true, done_reason: 'stop', eval_count: 5 })}\n`;
    const fetchStub = vi.fn().mockResolvedValue(ok(say('Yes.'), done));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(chunks).toContainEqual({ type: 'usage', outputTokens: 5 });
  });

  it('turns a non-2xx body into a named error', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response('{"error":"model \'llama3.1:8b\' not found"}', {
        status: 404,
      }),
    );

    const failure = await drain(provider(fetchStub).stream(request)).then(
      () => null,
      (error: unknown) => error as LlmError,
    );

    expect(failure!.status).toBe(404);
    expect(failure!.retryable).toBe(false);
    expect(failure!.message).toContain('not found');
  });

  it('turns an error line inside the stream into a non-retryable error', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(ok(`${JSON.stringify({ error: 'out of memory' })}\n`));

    const failure = await drain(provider(fetchStub).stream(request)).then(
      () => null,
      (error: unknown) => error as LlmError,
    );

    expect(failure!.retryable).toBe(false);
    expect(failure!.message).toContain('out of memory');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  // The daemon not running is the everyday failure of the default provider.
  it('retries a refused connection once', async () => {
    const fetchStub = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok(say('Ninety days.'), DONE));

    const chunks = await drain(provider(fetchStub).stream(request));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(textOf(chunks)).toBe('Ninety days.');
  });
});
