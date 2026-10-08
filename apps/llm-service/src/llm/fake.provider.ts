import type {
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
} from './llm-provider.js';

/**
 * Trigger phrases the e2e suite puts in a question to choose which of the
 * three behaviours it wants. Exported so the tests import them rather than
 * repeating a magic string that could drift out of step with this file.
 */
export const FAKE_NO_CITATION_TRIGGER = 'no-citation-please';
export const FAKE_BAD_CITATION_TRIGGER = 'bad-citation-please';

/** What the fake answers when it is behaving. `[1]` is the top-ranked chunk. */
const GROUNDED = 'According to the cited passage, that is the answer. [1]';
/** No marker at all — the post-generation abstention path. */
const UNGROUNDED =
  'I believe the answer is yes, but I will not say where from.';
/** A marker no context block ever has — the citation-validation path. */
const HALLUCINATED = 'The agreement says so. [9]';

/**
 * A deterministic, network-free `LlmProvider`, the counterpart of
 * `FakeEmbeddingProvider`: it lets the e2e suite drive the whole pipeline
 * without a key, a daemon or a bill, and — because its answers are fixed —
 * lets a test assert on the citation that comes out the other end.
 *
 * It answers nothing meaningful. It is refused when `NODE_ENV=production`, in
 * Joi, for the same reason the fake embedding provider is.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';

  constructor(readonly model: string = 'fake-legal-assistant') {}

  async *stream(
    request: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    const answer = this.answerFor(request.prompt);
    const words = answer.split(' ');

    yield {
      type: 'usage',
      // Deterministic and roughly proportional, so a test can assert it is
      // recorded without asserting a number that means anything.
      inputTokens: Math.ceil(
        (request.system.length + request.prompt.length) / 4,
      ),
    };

    // Word by word, so the stream really is a stream: a suite that asserts
    // "more than one token event" is asserting something.
    for (const [index, word] of words.entries()) {
      if (signal?.aborted) {
        return;
      }
      yield { type: 'text', text: index === 0 ? word : ` ${word}` };
    }

    yield { type: 'usage', outputTokens: words.length };
    yield { type: 'stop', reason: 'end_turn' };
  }

  private answerFor(prompt: string): string {
    if (prompt.includes(FAKE_NO_CITATION_TRIGGER)) {
      return UNGROUNDED;
    }
    if (prompt.includes(FAKE_BAD_CITATION_TRIGGER)) {
      return HALLUCINATED;
    }
    return GROUNDED;
  }
}

export const FAKE_ANSWERS = {
  grounded: GROUNDED,
  ungrounded: UNGROUNDED,
  hallucinated: HALLUCINATED,
} as const;
