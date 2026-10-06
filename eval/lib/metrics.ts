/**
 * Retrieval metrics of plan §9.2, for one question at a time. A question's
 * ground truth is a list of gold spans; each span is relevant in one or more
 * chunks (overlapping windows can share it), graded 1 (partly there) or 2
 * (all of it). Spans no chunk could be matched to never reach this file —
 * the labeller reports them instead.
 */
export interface SpanLabel {
  /** chunkId → grade (1 or 2). */
  chunks: Record<string, number>;
}

const relevantAt = (
  ranking: readonly string[],
  k: number,
  span: SpanLabel,
): boolean =>
  ranking.slice(0, k).some((chunkId) => (span.chunks[chunkId] ?? 0) > 0);

/** Share of the question's gold spans found in the top k (= hit@k for one span). */
export function recallAt(
  k: number,
  ranking: readonly string[],
  spans: readonly SpanLabel[],
): number {
  if (spans.length === 0) {
    return 0;
  }
  return (
    spans.filter((span) => relevantAt(ranking, k, span)).length / spans.length
  );
}

/**
 * Share of the gold spans found in the chunks that fit into `budget` tokens,
 * taken in ranked order. A chunk cut-off favours bigger chunks — a corpus cut
 * into fewer, longer pieces puts more text into every k — so chunking
 * strategies are compared on how much text reaches the model instead.
 */
export function recallWithin(
  budget: number,
  ranking: readonly string[],
  tokens: readonly number[],
  spans: readonly SpanLabel[],
): number {
  let used = 0;
  let k = 0;
  while (k < ranking.length && used + tokens[k] <= budget) {
    used += tokens[k];
    k++;
  }
  return recallAt(k, ranking, spans);
}

/** About two and four average clause-aware chunks; both fit in the top 10. */
export const TOKEN_BUDGETS = [2000, 4000] as const;

/** Best grade any span gives a chunk. */
function grades(spans: readonly SpanLabel[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const span of spans) {
    for (const [chunkId, grade] of Object.entries(span.chunks)) {
      best.set(chunkId, Math.max(best.get(chunkId) ?? 0, grade));
    }
  }
  return best;
}

/** 1 / rank of the first relevant chunk; 0 when none is in the ranking. */
export function reciprocalRank(
  ranking: readonly string[],
  spans: readonly SpanLabel[],
): number {
  const relevant = grades(spans);
  const index = ranking.findIndex(
    (chunkId) => (relevant.get(chunkId) ?? 0) > 0,
  );
  return index === -1 ? 0 : 1 / (index + 1);
}

/** nDCG@k with gain 2^grade − 1, against the ideal order of every relevant chunk. */
export function ndcgAt(
  k: number,
  ranking: readonly string[],
  spans: readonly SpanLabel[],
): number {
  const relevant = grades(spans);
  const gain = (grade: number): number => 2 ** grade - 1;
  const dcg = ranking
    .slice(0, k)
    .reduce(
      (sum, chunkId, i) =>
        sum + gain(relevant.get(chunkId) ?? 0) / Math.log2(i + 2),
      0,
    );
  const ideal = [...relevant.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export const CUTOFFS = [1, 3, 5, 10] as const;

export interface QuestionScores {
  recall: Record<number, number>;
  mrr: number;
  ndcg10: number;
}

export function scoreQuestion(
  ranking: readonly string[],
  spans: readonly SpanLabel[],
): QuestionScores {
  return {
    recall: Object.fromEntries(
      CUTOFFS.map((k) => [k, recallAt(k, ranking, spans)]),
    ),
    mrr: reciprocalRank(ranking, spans),
    ndcg10: ndcgAt(10, ranking, spans),
  };
}
