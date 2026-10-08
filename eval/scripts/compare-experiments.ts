// Pairs two experiments over the same questions — the side experiments of
// plan §9.2: the legal embedding model against a generic one, clause-aware
// chunking against naive. Each experiment is its own database and its own
// retrieval run, so run-retrieval's in-run differences cannot see across
// them; this pairs the per-question scores both runs wrote to retrieval.csv.
//
//   npm run eval:compare -- contracts_eval contracts_eval_generic
//
// Writes eval/results/<experiment>/versus-<baseline>.{md,json}.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRecords } from '../lib/csv.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import { resultsDir } from '../lib/paths.ts';
import type { RunInfo } from '../lib/run-info.ts';
import { type Interval, mean, pairedDifference } from '../lib/stats.ts';

const [baseline, experiment] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'));
if (!baseline || !experiment) {
  throw new Error('usage: compare-experiments.ts <baseline> <experiment>');
}

// t2k/t4k (recall within a token budget) are what a chunking comparison
// should be read on; older runs without them compare on the rest.
const ALL_METRICS = [
  'r1',
  'r3',
  'r5',
  'r10',
  'mrr',
  'ndcg10',
  't2k',
  't4k',
] as const;
type Metric = (typeof ALL_METRICS)[number];

function load(name: string) {
  const dir = resultsDir(name);
  const { info } = readJson<{ info: RunInfo }>(join(dir, 'retrieval.json'));
  const rows = parseCsvRecords(
    readFileSync(join(dir, 'retrieval.csv'), 'utf8'),
  );
  const byKey = new Map(
    rows.map((row) => [`${row.scope}|${row.config}|${row.question}`, row]),
  );
  return { info, rows, byKey };
}
const base = load(baseline);
const other = load(experiment);
const METRICS = ALL_METRICS.filter(
  (metric) => metric in base.rows[0] && metric in other.rows[0],
);

// A pair is only a pair over the same questions. Runs from before the
// fingerprint existed are compared with a warning rather than refused.
const fingerprint = (info: RunInfo) => info.questions?.sha256;
if (
  fingerprint(base.info) &&
  fingerprint(other.info) &&
  fingerprint(base.info) !== fingerprint(other.info)
) {
  throw new Error(
    `${baseline} and ${experiment} were run on different question sets`,
  );
}
const unverified = !fingerprint(base.info) || !fingerprint(other.info);

const changed = [
  ...new Set([
    ...Object.keys(base.info.settings),
    ...Object.keys(other.info.settings),
  ]),
]
  .filter((key) => base.info.settings[key] !== other.info.settings[key])
  .map(
    (key) =>
      `${key}: ${base.info.settings[key] ?? '(default)'} → ${other.info.settings[key] ?? '(default)'}`,
  );

interface Comparison {
  scope: string;
  config: string;
  n: number;
  metrics: Record<
    Metric,
    { baseline: number; experiment: number; difference: Interval }
  >;
}
const comparisons: Comparison[] = [];
const groups = [...new Set(base.rows.map((r) => `${r.scope}|${r.config}`))];
for (const group of groups) {
  const [scope, config] = group.split('|');
  const pairs = base.rows
    .filter((r) => r.scope === scope && r.config === config)
    .map((r) => [r, other.byKey.get(`${group}|${r.question}`)] as const)
    .filter(
      (
        pair,
      ): pair is readonly [Record<string, string>, Record<string, string>] =>
        pair[1] !== undefined,
    );
  if (pairs.length === 0) {
    continue;
  }
  const metrics = Object.fromEntries(
    METRICS.map((metric) => {
      const left = pairs.map(([a]) => Number(a[metric]));
      const right = pairs.map(([, b]) => Number(b[metric]));
      return [
        metric,
        {
          baseline: mean(left),
          experiment: mean(right),
          difference: pairedDifference(left, right),
        },
      ];
    }),
  ) as Comparison['metrics'];
  comparisons.push({ scope, config, n: pairs.length, metrics });
}

const dir = resultsDir(experiment);
writeJson(join(dir, `versus-${baseline}.json`), {
  baseline: base.info,
  experiment: other.info,
  changed,
  comparisons,
});

const f = (value: number) => value.toFixed(3);
const md = [
  `# ${experiment} versus ${baseline}`,
  '',
  `Changed settings: ${changed.length > 0 ? changed.join('; ') : 'none recorded'}.`,
  '',
  unverified
    ? 'One of the runs predates the question-set fingerprint: check that both used the same questions.json.'
    : `Same question set (${base.info.questions.status}, ${base.info.questions.sha256}).`,
  '',
  'Each cell: baseline → experiment, then the paired difference (experiment − baseline) with its 95 % bootstrap interval.',
  '',
];
for (const scope of new Set(comparisons.map((c) => c.scope))) {
  md.push(
    `## Scope: ${scope}`,
    '',
    `| config | n | ${METRICS.join(' | ')} |`,
    `|---|---|${METRICS.map(() => '---').join('|')}|`,
  );
  for (const c of comparisons.filter((x) => x.scope === scope)) {
    const cells = METRICS.map((metric) => {
      const m = c.metrics[metric];
      return `${f(m.baseline)} → ${f(m.experiment)}; ${f(m.difference.mean)} [${f(m.difference.low)}, ${f(m.difference.high)}]`;
    });
    md.push(`| ${c.config} | ${c.n} | ${cells.join(' | ')} |`);
  }
  md.push('');
}
md.push(
  'A difference whose interval excludes 0 is supported by this question set.',
);
writeText(join(dir, `versus-${baseline}.md`), `${md.join('\n')}\n`);
console.log(md.join('\n'));
