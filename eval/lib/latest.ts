import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir } from './paths.ts';

/** The newest raw file of a kind (`retrieval`, `answers`, …) for an experiment. */
export function latestRaw(experiment: string, kind: string): string {
  const dir = resultsDir(experiment, 'raw');
  const files = readdirSync(dir)
    .filter((file) => file.startsWith(`${kind}-`) && file.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No raw ${kind} run in ${dir}`);
  }
  return join(dir, files[files.length - 1]);
}
