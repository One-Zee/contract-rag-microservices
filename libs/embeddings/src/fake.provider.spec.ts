import { FakeEmbeddingProvider } from './fake.provider.js';

const DIMENSIONS = 1024;

const cosine = (a: number[], b: number[]): number =>
  a.reduce((sum, value, i) => sum + value * b[i], 0);

const norm = (v: number[]): number => Math.hypot(...v);

describe('FakeEmbeddingProvider', () => {
  const provider = new FakeEmbeddingProvider(DIMENSIONS);

  it('returns one unit vector of the configured dimension per text, in order', async () => {
    const { vectors, totalTokens } = await provider.embed(
      ['The Supplier shall deliver the Services.', 'Governing law: Bosnia.'],
      'document',
    );

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(DIMENSIONS);
      expect(norm(vector)).toBeCloseTo(1, 6);
    }
    expect(totalTokens).toBe(6 + 3);
  });

  it('is deterministic: the same text always gives the same vector', async () => {
    const [first] = (await provider.embed(['termination notice'], 'document'))
      .vectors;
    const [second] = (
      await new FakeEmbeddingProvider(DIMENSIONS).embed(
        ['termination notice'],
        'document',
      )
    ).vectors;

    expect(second).toEqual(first);
  });

  it('ranks a text that shares words above one that shares none', async () => {
    const {
      vectors: [query, related, unrelated],
    } = await provider.embed(
      [
        'notice period for termination',
        'Either party may terminate this Agreement with a notice period of ninety days',
        'The Supplier warrants that the Services are free from defects',
      ],
      'document',
    );

    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
    expect(cosine(query, related)).toBeGreaterThan(0.2);
  });

  it('ignores case and punctuation when hashing words', async () => {
    const {
      vectors: [a, b],
    } = await provider.embed(
      ['Termination, Notice!', 'termination notice'],
      'query',
    );

    expect(a).toEqual(b);
  });

  it('gives an empty or wordless text a fixed unit vector rather than NaN', async () => {
    const {
      vectors: [empty, punctuation],
      totalTokens,
    } = await provider.embed(['', '--- ...'], 'document');

    expect(empty.every(Number.isFinite)).toBe(true);
    expect(norm(empty)).toBeCloseTo(1, 6);
    expect(punctuation).toEqual(empty);
    expect(totalTokens).toBe(0);
  });

  it('does not distinguish documents from queries — the hash has no prompt', async () => {
    const [asDocument] = (await provider.embed(['payment terms'], 'document'))
      .vectors;
    const [asQuery] = (await provider.embed(['payment terms'], 'query'))
      .vectors;

    expect(asQuery).toEqual(asDocument);
  });

  it('handles an empty batch', async () => {
    await expect(provider.embed([], 'document')).resolves.toEqual({
      vectors: [],
      totalTokens: 0,
    });
  });
});
