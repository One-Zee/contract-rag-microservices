import { seededRandom } from './random.ts';

export const mean = (values: readonly number[]): number =>
  values.length === 0
    ? Number.NaN
    : values.reduce((a, b) => a + b, 0) / values.length;

/** Linear interpolation between closest ranks (numpy's default). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const RESAMPLES = 10_000;

export interface Interval {
  mean: number;
  low: number;
  high: number;
}

/**
 * Percentile bootstrap of the mean, 95 %. With 40–50 questions a mean alone
 * hides how much a different set of questions could have moved it.
 */
export function bootstrapMean(values: readonly number[], seed = 1): Interval {
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let r = 0; r < RESAMPLES; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  return {
    mean: mean(values),
    low: percentile(means, 2.5),
    high: percentile(means, 97.5),
  };
}

/**
 * Paired bootstrap of `b − a` over the same questions: the comparison §9.2
 * makes between configurations. An interval that excludes 0 is a difference
 * this question set supports.
 */
export function pairedDifference(
  a: readonly number[],
  b: readonly number[],
  seed = 1,
): Interval {
  if (a.length !== b.length) {
    throw new Error('paired samples must have the same length');
  }
  const differences = a.map((value, i) => b[i] - value);
  return bootstrapMean(differences, seed);
}
