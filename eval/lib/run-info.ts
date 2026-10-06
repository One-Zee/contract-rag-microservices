import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QUESTIONS_FILE, REPO_ROOT } from './paths.ts';

/**
 * Settings that change a number. The harness can only see its own
 * environment, so the services must be started from the same shell — the
 * README says so, and every result file records what that shell said.
 */
const RECORDED = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'VOYAGE_BASE_URL',
  'CHUNK_SIZE_TOKENS',
  'CHUNK_OVERLAP_TOKENS',
  'CHUNK_RESPECT_SECTIONS',
  'SEARCH_CANDIDATES',
  'SEARCH_FUSED',
  'SEARCH_TOP_K',
  'RRF_K',
  'HNSW_EF_SEARCH',
  'LEXICAL_MATCH',
  'RERANK_PROVIDER',
  'RERANK_MODEL',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'QUERY_CONTEXT_CHUNKS',
  'QUERY_MIN_SIMILARITY',
  'QUERY_CONTEXT_MAX_TOKENS',
] as const;

export interface RunInfo {
  experiment: string;
  startedAt: string;
  commit: string;
  dirty: boolean;
  node: string;
  /** Which question set produced the number — runs pair only on the same one. */
  questions: { status: string; sha256: string };
  settings: Record<string, string>;
}

export function runInfo(experiment: string): RunInfo {
  const git = (...args: string[]): string =>
    spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  return {
    experiment,
    startedAt: new Date().toISOString(),
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
    node: process.version,
    questions: questionSet(),
    settings: Object.fromEntries(
      RECORDED.filter(
        (name) => process.env[name] !== undefined && process.env[name] !== '',
      ).map((name) => [name, process.env[name] as string]),
    ),
  };
}

function questionSet(): RunInfo['questions'] {
  const text = readFileSync(QUESTIONS_FILE, 'utf8');
  return {
    status: (JSON.parse(text) as { status: string }).status,
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
  };
}
