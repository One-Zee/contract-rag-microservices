import { NoReranker } from './none.reranker.js';
import type { RerankCandidate } from './reranker.js';

const candidates: RerankCandidate[] = [
  { id: 'a', text: 'first' },
  { id: 'b', text: 'second' },
  { id: 'c', text: 'third' },
];

describe('NoReranker', () => {
  it('keeps the order it was given and cuts at the limit', async () => {
    const ranked = await new NoReranker().rerank('q', candidates, 2);

    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
  });

  // The caller sorts by score; descending scores make that a no-op rather
  // than a reshuffle of the fusion order.
  it('reports descending scores so sorting cannot reorder it', async () => {
    const ranked = await new NoReranker().rerank('q', candidates, 3);

    expect(ranked.map((r) => r.score)).toEqual([1, 1 / 2, 1 / 3]);
    expect([...ranked].sort((a, b) => b.score - a.score)).toEqual(ranked);
  });

  it('handles an empty list and a zero limit', async () => {
    const reranker = new NoReranker();

    await expect(reranker.rerank('q', [], 5)).resolves.toEqual([]);
    await expect(reranker.rerank('q', candidates, 0)).resolves.toEqual([]);
  });

  it('names itself `none` and claims no model', () => {
    const reranker = new NoReranker();

    expect(reranker.name).toBe('none');
    expect(reranker.model).toBe('');
  });
});
