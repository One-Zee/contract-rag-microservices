// The reranker is the one paid API whose per-minute limit bites here: a trial
// Cohere key allows 10 rerank calls a minute (and 1,000 a month). A rerank
// that fails is not an error — the service keeps the fusion order and reports
// `reranker: "none"` — so an unpaced run would quietly score the third
// configuration under the fourth one's name.
import { setTimeout as sleep } from 'node:timers/promises';

/** Whether the services run with a reranker — they share this shell's env. */
export const rerankConfigured = (): boolean =>
  (process.env.RERANK_PROVIDER ?? 'none') !== 'none';

/**
 * Returns a function to await before every request that reranks, keeping the
 * run under `RERANK_PER_MINUTE` (default 8: any 60-second window then holds
 * at most 9 calls, under the trial key's 10; 0 turns pacing off for a
 * production key).
 */
export function rerankPacer(): () => Promise<void> {
  const perMinute = Number(process.env.RERANK_PER_MINUTE ?? 8);
  const intervalMs = perMinute > 0 ? 60_000 / perMinute : 0;
  let last = Number.NEGATIVE_INFINITY;
  return async () => {
    const wait = last + intervalMs - performance.now();
    if (wait > 0) {
      await sleep(wait);
    }
    last = performance.now();
  };
}
