// The main experiment of plan §9.2: every labelled question against four
// configurations of the same pipeline, over the whole corpus and inside the
// question's own contract.
//
//   npm run eval:retrieval [-- --allow-draft --scope corpus|document|both]
//
// Requests go one at a time, so the recorded timings are those of an idle
// system — the latency of a configuration, not of contention.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Gateway, type SearchResponse } from '../lib/api.ts';
import { loadQuestions } from '../lib/dataset.ts';
import { args, experimentName, gatewayUrl, loadEnv } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import { withDb } from '../lib/db.ts';
import {
  CUTOFFS,
  type QuestionScores,
  recallWithin,
  scoreQuestion,
  type SpanLabel,
  TOKEN_BUDGETS,
} from '../lib/metrics.ts';
import { resultsDir } from '../lib/paths.ts';
import { rerankConfigured, rerankPacer } from '../lib/rerank.ts';
import { runInfo } from '../lib/run-info.ts';
import {
  bootstrapMean,
  type Interval,
  pairedDifference,
  percentile,
} from '../lib/stats.ts';
import { toCsv } from '../lib/csv.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const scopeOption = String(options.get('scope') ?? 'both');
const SCOPES = scopeOption === 'both' ? ['corpus', 'document'] : [scopeOption];
const LIMIT = 10;

const CONFIGS = [
  { name: 'vector', mode: 'vector', rerank: false },
  { name: 'lexical', mode: 'lexical', rerank: false },
  { name: 'hybrid', mode: 'hybrid', rerank: false },
  { name: 'hybrid+rerank', mode: 'hybrid', rerank: true },
] as const;

const dir = resultsDir(experiment);
const labels = readJson<{
  labels: Record<string, { documentId: string; spans: SpanLabel[] }>;
}>(join(resultsDir(experiment, 'raw'), 'labels.json')).labels;
const questions = loadQuestions(options.has('allow-draft')).questions;

const gateway = new Gateway(gatewayUrl());
await gateway.login(
  process.env.EVAL_EMAIL ?? 'evaluation@clauseiq.test',
  process.env.EVAL_PASSWORD ?? 'evaluation-only-password',
);

interface RunRecord {
  question: string;
  kind: string;
  config: string;
  scope: string;
  reranker: string;
  ranking: string[];
  /** token_count of every ranked chunk, for the token-budget recall. */
  rankingTokens: number[];
  similarities: number[];
  timings: SearchResponse['timings'];
  scores: (QuestionScores & { budget: Record<number, number> }) | null;
}
const records: RunRecord[] = [];
const skipped = new Set<string>();
const reranks = rerankConfigured();
const pace = rerankPacer();

type Config = (typeof CONFIGS)[number];
type SearchParams = Parameters<Gateway['search']>[0];

/**
 * A configured reranker that answers "none" failed — most likely the trial
 * key's per-minute limit. Wait the minute out and ask again rather than score
 * the fusion order as if it were reranked; give up loudly after three tries.
 */
async function search(
  config: Config,
  params: SearchParams,
  questionId: string,
): Promise<SearchResponse> {
  if (!config.rerank) {
    return gateway.search(params);
  }
  for (let attempt = 1; ; attempt++) {
    await pace();
    const response = await gateway.search(params);
    if (response.reranker !== 'none') {
      return response;
    }
    if (attempt === 3) {
      throw new Error(
        `reranking failed three times for ${questionId}; see the retrieval-service log`,
      );
    }
    console.warn(`  ${questionId}: rerank failed, retrying in 60 s`);
    await sleep(60_000);
  }
}

for (const scope of SCOPES) {
  for (const config of CONFIGS) {
    if (config.rerank && !reranks) {
      skipped.add(config.name);
      continue;
    }
    for (const question of questions) {
      const label = labels[question.id];
      const scored =
        question.kind === 'answerable' && label && label.spans.length > 0;
      // Unanswerable questions run corpus-wide only: they are not scored, they
      // feed the abstention threshold (calibrate-threshold).
      if (!scored && (scope !== 'corpus' || question.kind === 'answerable')) {
        continue;
      }
      const response = await search(
        config,
        {
          q: question.question,
          mode: config.mode,
          limit: LIMIT,
          rerank: config.rerank,
          documentId: scope === 'document' ? label?.documentId : undefined,
        },
        question.id,
      );
      const ranking = response.results.map((hit) => hit.chunkId);
      records.push({
        question: question.id,
        kind: question.kind,
        config: config.name,
        scope,
        reranker: response.reranker,
        ranking,
        rankingTokens: [],
        similarities: response.results.map((hit) => hit.similarity),
        timings: response.timings,
        scores: scored
          ? { ...scoreQuestion(ranking, label.spans), budget: {} }
          : null,
      });
    }
    console.log(`  ${scope} / ${config.name}: done`);
  }
}

// Chunk sizes come from the database after the timed requests, never during.
const tokenCounts = await withDb(async (db) => {
  const ids = [...new Set(records.flatMap((r) => r.ranking))];
  const { rows } = await db.query<{ id: string; token_count: number }>(
    'SELECT id, token_count FROM chunks WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.token_count]));
});
for (const record of records) {
  record.rankingTokens = record.ranking.map((id) => tokenCounts.get(id) ?? 0);
  if (record.scores) {
    const spans = labels[record.question].spans;
    record.scores.budget = Object.fromEntries(
      TOKEN_BUDGETS.map((budget) => [
        budget,
        recallWithin(budget, record.ranking, record.rankingTokens, spans),
      ]),
    );
  }
}

const info = runInfo(experiment);
const stamp = info.startedAt.replace(/[:.]/g, '-');
writeJson(join(resultsDir(experiment, 'raw'), `retrieval-${stamp}.json`), {
  info,
  records,
});

// ── Summary ──────────────────────────────────────────────────────────────────
type Metric = 'r1' | 'r3' | 'r5' | 'r10' | 'mrr' | 'ndcg10' | 't2k' | 't4k';
const METRICS: Metric[] = [
  'r1',
  'r3',
  'r5',
  'r10',
  'mrr',
  'ndcg10',
  't2k',
  't4k',
];
const value = (scores: RunRecord['scores'] & {}, metric: Metric): number =>
  metric === 'mrr'
    ? scores.mrr
    : metric === 'ndcg10'
      ? scores.ndcg10
      : metric.startsWith('t')
        ? scores.budget[Number(metric.slice(1, -1)) * 1000]
        : scores.recall[Number(metric.slice(1))];

const summary: Record<
  string,
  Record<
    string,
    Record<Metric, Interval> & {
      n: number;
      latencyP50: number;
      latencyP95: number;
    }
  >
> = {};
const perQuestion: Record<string, unknown>[] = [];
for (const scope of SCOPES) {
  summary[scope] = {};
  for (const config of CONFIGS) {
    if (skipped.has(config.name)) {
      continue;
    }
    const rows = records.filter(
      (r) => r.scope === scope && r.config === config.name && r.scores,
    );
    const metrics = Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        bootstrapMean(rows.map((r) => value(r.scores!, metric))),
      ]),
    ) as Record<Metric, Interval>;
    const latencies = rows.map((r) => r.timings.totalMs);
    summary[scope][config.name] = {
      ...metrics,
      n: rows.length,
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
    };
    for (const row of rows) {
      perQuestion.push({
        scope,
        config: config.name,
        question: row.question,
        ...Object.fromEntries(
          METRICS.map((metric) => [
            metric,
            value(row.scores!, metric).toFixed(4),
          ]),
        ),
        totalMs: row.timings.totalMs,
      });
    }
  }
}

// The comparisons §9.2 is about, paired over the same questions.
const PAIRS = [
  ['vector', 'hybrid'],
  ['lexical', 'hybrid'],
  ['hybrid', 'hybrid+rerank'],
] as const;
const differences: Record<
  string,
  Record<string, Record<Metric, Interval>>
> = {};
for (const scope of SCOPES) {
  differences[scope] = {};
  for (const [a, b] of PAIRS) {
    if (skipped.has(a) || skipped.has(b)) {
      continue;
    }
    const left = records.filter(
      (r) => r.scope === scope && r.config === a && r.scores,
    );
    const right = new Map(
      records
        .filter((r) => r.scope === scope && r.config === b && r.scores)
        .map((r) => [r.question, r]),
    );
    const paired = left.filter((r) => right.has(r.question));
    differences[scope][`${b} − ${a}`] = Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        pairedDifference(
          paired.map((r) => value(r.scores!, metric)),
          paired.map((r) =>
            value((right.get(r.question) as RunRecord).scores!, metric),
          ),
        ),
      ]),
    ) as Record<Metric, Interval>;
  }
}

writeJson(join(dir, 'retrieval.json'), {
  info,
  skipped: [...skipped],
  summary,
  differences,
});
writeText(join(dir, 'retrieval.csv'), toCsv(perQuestion));

const fmt = (interval: Interval): string =>
  `${interval.mean.toFixed(3)} [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
const md: string[] = [
  `# Retrieval — ${experiment}`,
  '',
  `Run ${info.startedAt}, commit ${info.commit}${info.dirty ? ' (dirty)' : ''}.`,
  '',
];
if (skipped.size > 0) {
  md.push(`Skipped (no reranker configured): ${[...skipped].join(', ')}.`, '');
}
for (const scope of SCOPES) {
  md.push(
    `## Scope: ${scope}`,
    '',
    `| config | n | ${CUTOFFS.map((k) => `R@${k}`).join(' | ')} | MRR | nDCG@10 | ${TOKEN_BUDGETS.map((t) => `R@${t / 1000}k tok`).join(' | ')} | p50 ms | p95 ms |`,
    `|---|---|${CUTOFFS.map(() => '---').join('|')}|---|---|${TOKEN_BUDGETS.map(() => '---').join('|')}|---|---|`,
  );
  for (const [name, row] of Object.entries(summary[scope])) {
    md.push(
      `| ${name} | ${row.n} | ${METRICS.map((metric) => fmt(row[metric])).join(' | ')} | ${row.latencyP50.toFixed(0)} | ${row.latencyP95.toFixed(0)} |`,
    );
  }
  md.push(
    '',
    '| difference | ' + METRICS.join(' | ') + ' |',
    `|---|${METRICS.map(() => '---').join('|')}|`,
  );
  for (const [name, row] of Object.entries(differences[scope])) {
    md.push(
      `| ${name} | ${METRICS.map((metric) => fmt(row[metric])).join(' | ')} |`,
    );
  }
  md.push('');
}
md.push(
  'Means with a 95 % bootstrap interval (10 000 resamples). A difference whose interval excludes 0 is supported by this question set.',
  'R@2k/4k tok: share of gold spans in the ranked chunks that fit into 2,000 / 4,000 tokens — the fair cut-off between chunkings of different chunk sizes.',
);
writeText(join(dir, 'retrieval.md'), `${md.join('\n')}\n`);
console.log(md.join('\n'));
