import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const EVAL_ROOT = join(REPO_ROOT, 'eval');
export const DATA_DIR = join(EVAL_ROOT, 'data');
export const CUAD_DIR = join(DATA_DIR, 'CUAD_v1');
export const DATASET_DIR = join(EVAL_ROOT, 'dataset');
export const CONTRACTS_FILE = join(DATASET_DIR, 'contracts.json');
export const QUESTIONS_FILE = join(DATASET_DIR, 'questions.json');

/**
 * Results live per experiment — one experiment is one database, because a
 * different embedding model or chunking strategy is a different corpus.
 */
export function resultsDir(experiment: string, ...parts: string[]): string {
  const dir = join(EVAL_ROOT, 'results', experiment, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
