/**
 * Reciprocal rank fusion — how the vector and the lexical branch are combined.
 *
 * Each branch produces a ranking, not a score that means anything outside it:
 * a cosine similarity of 0.82 and a `ts_rank_cd` of 0.09 cannot be added,
 * averaged or compared, and normalising them per query only hides that. RRF
 * throws the scores away and keeps the positions:
 *
 *     score(d) = Σ 1 / (k + rank_i(d))
 *
 * over the branches that returned `d`. A chunk both branches liked outranks
 * one that a single branch put first, which is the whole point of searching
 * twice
 */
export interface RankedId {
  id: string;
  /** 1-based position in the branch that produced it. */
  rank: number;
}

export interface FusedId {
  id: string;
  score: number;
  /** The 1-based rank in each input list, `null` where the list missed it. */
  ranks: (number | null)[];
}

/**
 * `lists` keeps its order: `ranks[i]` belongs to `lists[i]`, so the caller can
 * label the branches without a second pass. Ties keep the order in which the
 * ids were first seen, which makes the output stable for a given input rather
 * than dependent on the engine's sort.
 */
export const fuse = (lists: RankedId[][], k: number): FusedId[] => {
  const fused = new Map<string, FusedId>();

  for (const [listIndex, list] of lists.entries()) {
    for (const { id, rank } of list) {
      let entry = fused.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: Array.from(lists, () => null) };
        fused.set(id, entry);
      }
      entry.score += 1 / (k + rank);
      entry.ranks[listIndex] = rank;
    }
  }

  // Insertion order is the tie-break: `sort` is stable, and a Map iterates in
  // the order keys were added.
  return [...fused.values()].sort((a, b) => b.score - a.score);
};
