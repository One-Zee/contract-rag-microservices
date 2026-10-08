import {
  FAKE_ANSWERS,
  FAKE_BAD_CITATION_TRIGGER,
  FAKE_NO_CITATION_TRIGGER,
  FakeLlmProvider,
} from './fake.provider.js';
import type { LlmStreamChunk } from './llm-provider.js';

const request = (prompt: string) => ({
  system: 'You are a legal assistant.',
  prompt,
  maxTokens: 1024,
});

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

describe('FakeLlmProvider', () => {
  const provider = new FakeLlmProvider();

  it('answers with a citation and reports usage', async () => {
    const chunks = await drain(provider.stream(request('[1] a clause')));

    expect(textOf(chunks)).toBe(FAKE_ANSWERS.grounded);
    expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'usage',
        outputTokens: expect.any(Number),
      }),
    );
  });

  it('is deterministic', async () => {
    const once = textOf(await drain(provider.stream(request('[1] a clause'))));
    const twice = textOf(await drain(provider.stream(request('[1] a clause'))));

    expect(once).toBe(twice);
  });

  it('answers without any citation when the question asks it to', async () => {
    const chunks = await drain(
      provider.stream(request(`[1] a clause\n\n${FAKE_NO_CITATION_TRIGGER}`)),
    );

    expect(textOf(chunks)).toBe(FAKE_ANSWERS.ungrounded);
    expect(textOf(chunks)).not.toMatch(/\[\d+]/);
  });

  it('cites an index that is not in the context when asked to', async () => {
    const chunks = await drain(
      provider.stream(request(`[1] a clause\n\n${FAKE_BAD_CITATION_TRIGGER}`)),
    );

    expect(textOf(chunks)).toBe(FAKE_ANSWERS.hallucinated);
    expect(textOf(chunks)).toContain('[9]');
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const chunks: LlmStreamChunk[] = [];

    for await (const chunk of provider.stream(
      request('[1] a clause'),
      controller.signal,
    )) {
      chunks.push(chunk);
      if (chunks.filter((c) => c.type === 'text').length === 2) {
        controller.abort();
      }
    }

    expect(textOf(chunks).length).toBeLessThan(FAKE_ANSWERS.grounded.length);
  });
});
