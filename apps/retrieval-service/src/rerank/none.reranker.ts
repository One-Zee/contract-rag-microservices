import type {
  RerankCandidate,
  RerankedCandidate,
  Reranker,
} from './reranker.js';

export const NO_RERANK_MODEL = '';

/**
 * Keeps the order fusion produced, and calls nothing.
 *
 * This is the default, not a test double: reranking costs a request and a key
 * per search, and RRF already produces a defensible order. It is also what the
 * pipeline falls back to when the real reranker fails, and what the `rerank=0`
 * arm of the experiment in plan §9.2 measures.
 *
 * The scores it reports are descending positions (`1/rank`), so a caller
 * sorting by `score` cannot reorder the list by accident.
 */
export class NoReranker implements Reranker {
  readonly name = 'none';
  readonly model = NO_RERANK_MODEL;

  rerank(
    _query: string,
    candidates: RerankCandidate[],
    topN: number,
  ): Promise<RerankedCandidate[]> {
    return Promise.resolve(
      candidates.slice(0, Math.max(0, topN)).map((candidate, index) => ({
        id: candidate.id,
        score: 1 / (index + 1),
      })),
    );
  }
}
