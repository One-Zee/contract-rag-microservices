import { createHash } from 'node:crypto';
import type {
  EmbeddingBatch,
  EmbeddingInputType,
  EmbeddingProvider,
} from './embedding-provider.js';

export const FAKE_MODEL = 'hashed-bag-of-words';

/** Letters and digits in any script — a word is what stands between the rest. */
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Deterministic, network-free embeddings for tests and for a machine without
 * an API key: the classic feature-hashing bag of words. Every word hashes to
 * one coordinate and a sign, the counts are summed and the vector is scaled
 * to unit length. The same text therefore always gives the same vector, and
 * two texts that share words have a higher cosine similarity than two that
 * share none — enough for an end-to-end test to find the chunk it planted,
 * and nothing more: there is no meaning in these numbers, which is why the
 * schema refuses this provider in production.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model = FAKE_MODEL;

  constructor(readonly dimensions: number) {}

  async embed(
    texts: string[],
    _inputType: EmbeddingInputType,
  ): Promise<EmbeddingBatch> {
    let totalTokens = 0;
    const vectors = texts.map((text) => {
      const words = text.toLowerCase().match(WORD) ?? [];
      totalTokens += words.length;
      return this.vectorOf(words);
    });
    return { vectors, totalTokens };
  }

  private vectorOf(words: string[]): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    for (const word of words) {
      const digest = createHash('sha256').update(word).digest();
      const coordinate = digest.readUInt32BE(0) % this.dimensions;
      const sign = digest[4] & 1 ? 1 : -1;
      vector[coordinate] += sign;
    }

    const norm = Math.hypot(...vector);
    if (norm === 0) {
      // No words at all — a fixed unit vector rather than NaN everywhere.
      vector[0] = 1;
      return vector;
    }
    return vector.map((value) => value / norm);
  }
}
