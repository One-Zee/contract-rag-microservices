// Turns eval/results/load/raw/ into the tables of §9.4 and §9.5:
// eval/results/load/summary.md and summary.csv (committed), plus a time
// series per burst run for the figure.
//
//   node eval/load/summarize.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, toCsv } from '../lib/csv.ts';
import { readJson, writeText } from '../lib/json.ts';
import { EVAL_ROOT } from '../lib/paths.ts';
import { percentile } from '../lib/stats.ts';

const ROOT = join(EVAL_ROOT, 'results', 'load');
const RAW = join(ROOT, 'raw');
const APP =
  /api-gateway|auth-service|ingestion-service|indexing-service|retrieval-service|llm-service|monolith|express-auth/;

const median = (values: number[]): number => percentile(values, 50);

function mebibytes(value: string): number {
  const match = /([\d.]+)\s*([KMG]i?B|B)/.exec(value);
  if (!match) return 0;
  const factor: Record<string, number> = {
    B: 1 / 1048576,
    KiB: 1 / 1024,
    KB: 1 / 1024,
    MiB: 1,
    MB: 1,
    GiB: 1024,
    GB: 1024,
  };
  return Number(match[1]) * (factor[match[2]] ?? 1);
}

interface Sample {
  t: number;
  name: string;
  cpu: number;
  mem: string;
}

/**
 * The containers whose cost a run measures: the target alone when it is one
 * process (the Express twin, the monolith — in the overhead runs both are up,
 * and the idle one is not the target's cost), every application container
 * otherwise.
 */
function appContainers(target: string | undefined): RegExp {
  const host = target ? new URL(target).hostname : '';
  if (host === 'express-auth') return /express-auth/;
  if (host === 'monolith') return /monolith/;
  return APP;
}

/**
 * Mean CPU % of each counted container over the run, summed (100 % = one
 * core), and the sum of their peak memory. Per container, not per refresh:
 * `docker stats` into a pipe arrives in a few large chunks, so the arrival
 * time the sampler records cannot group one refresh's lines together.
 */
function resources(
  file: string,
  target: string | undefined,
): {
  cpu: number;
  mem: number;
  postgresCpu: number;
} {
  if (!existsSync(file))
    return { cpu: Number.NaN, mem: Number.NaN, postgresCpu: Number.NaN };
  const samples = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sample);
  const counted = appContainers(target);
  const cpu = new Map<string, number[]>();
  const postgres: number[] = [];
  const peak = new Map<string, number>();
  for (const sample of samples) {
    if (counted.test(sample.name)) {
      cpu.set(sample.name, [...(cpu.get(sample.name) ?? []), sample.cpu || 0]);
      peak.set(
        sample.name,
        Math.max(peak.get(sample.name) ?? 0, mebibytes(sample.mem)),
      );
    } else if (sample.name.includes('postgres')) {
      postgres.push(sample.cpu || 0);
    }
  }
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  return {
    cpu: cpu.size
      ? [...cpu.values()].reduce((sum, values) => sum + mean(values), 0)
      : Number.NaN,
    mem: [...peak.values()].reduce((a, b) => a + b, 0),
    postgresCpu: postgres.length ? mean(postgres) : Number.NaN,
  };
}

interface Row {
  label: string;
  scenario: string;
  vus: number;
  rep: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  failed: number;
  cpu: number;
  mem: number;
  postgresCpu: number;
}

const rows: Row[] = [];
const invalid: string[] = [];
const bursts: { label: string; dir: string }[] = [];
for (const label of existsSync(RAW) ? readdirSync(RAW) : []) {
  const labelDir = join(RAW, label);
  if (label.startsWith('.') || label === 'smoke') continue;
  for (const run of readdirSync(labelDir)) {
    const dir = join(labelDir, run);
    if (run === 'burst') {
      bursts.push({ label, dir });
      continue;
    }
    const match = /^(.*)-(\d+)vu-r(\d+)$/.exec(run);
    if (!match || !existsSync(join(dir, 'summary.json'))) continue;
    const summary = readJson<any>(join(dir, 'summary.json'));
    const meta = existsSync(join(dir, 'run.json'))
      ? readJson<{ duration: string; target?: string }>(join(dir, 'run.json'))
      : { duration: '60s', target: undefined };
    // The scenario's own requests: the sub-metric leaves out the setup login,
    // which k6 also counts into the run's duration — so the rate is taken
    // from the iterations over the scenario's duration, not from http_reqs.
    const tag = match[1].replace(/^overhead-/, '');
    const duration = (
      summary.metrics[`http_req_duration{name:${tag}}`] ??
      summary.metrics.http_req_duration
    ).values;
    const seconds =
      Number.parseFloat(meta.duration) * (meta.duration.endsWith('m') ? 60 : 1);
    // A run is only valid if it lasted about as long as planned: a machine
    // that slept, or a stalled setup, stretches the run and every request in
    // flight. Setup and the graceful stop get 45 s.
    const actualMs = summary.state?.testRunDurationMs ?? 0;
    if (actualMs > seconds * 1000 + 45_000) {
      invalid.push(
        `${label}/${run}: ${(actualMs / 1000).toFixed(0)} s for a ${meta.duration} run`,
      );
      continue;
    }
    rows.push({
      label,
      scenario: match[1],
      vus: Number(match[2]),
      rep: Number(match[3]),
      rps: summary.metrics.iterations.values.count / seconds,
      p50: duration.med,
      p95: duration['p(95)'],
      p99: duration['p(99)'],
      failed: summary.metrics.http_req_failed?.values.rate ?? 0,
      ...resources(join(dir, 'stats.jsonl'), meta.target),
    });
  }
}

// Median over the repetitions of each (label, scenario, vus).
const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.scenario}|${row.label}|${row.vus}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
const medians = [...groups.values()]
  .map((group) => ({
    scenario: group[0].scenario,
    label: group[0].label,
    vus: group[0].vus,
    reps: group.length,
    rps: median(group.map((r) => r.rps)),
    p50: median(group.map((r) => r.p50)),
    p95: median(group.map((r) => r.p95)),
    p99: median(group.map((r) => r.p99)),
    failedPct: 100 * median(group.map((r) => r.failed)),
    appCpuPct: median(group.map((r) => r.cpu)),
    appMemMiB: median(group.map((r) => r.mem)),
    postgresCpuPct: median(group.map((r) => r.postgresCpu)),
  }))
  .sort((a, b) =>
    a.scenario === b.scenario
      ? a.vus === b.vus
        ? a.label.localeCompare(b.label)
        : a.vus - b.vus
      : a.scenario.localeCompare(b.scenario),
  );

if (invalid.length > 0) {
  console.warn(
    `Excluded, ran far longer than planned:\n  ${invalid.join('\n  ')}`,
  );
}

const fixed = (value: number, digits = 0) =>
  Number.isNaN(value) ? '—' : value.toFixed(digits);
const md: string[] = [
  '# Load tests',
  '',
  "Medians over the repetitions (column `n`). App CPU is the sum of the measured containers' mean CPU % (100 % = one core) and app MiB the sum of their peaks — the target alone for the Express twin and the 1-CPU monolith, every application container otherwise. Stubbed providers, tracing off, throttling off.",
  '',
];
for (const scenario of new Set(medians.map((m) => m.scenario))) {
  md.push(
    `## ${scenario}`,
    '',
    '| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const m of medians.filter((x) => x.scenario === scenario)) {
    md.push(
      `| ${m.label} | ${m.vus} | ${m.reps} | ${fixed(m.rps, 1)} | ${fixed(m.p50)} | ${fixed(m.p95)} | ${fixed(m.p99)} | ${fixed(m.failedPct, 2)} | ${fixed(m.appCpuPct)} | ${fixed(m.appMemMiB)} | ${fixed(m.postgresCpuPct)} |`,
    );
  }
  md.push('');
}

// ── Bursts: search latency before, during and after a batch of uploads ─────
const WINDOW_S = 10;
const burstRows: Record<string, unknown>[] = [];
for (const { label, dir } of bursts) {
  if (!existsSync(join(dir, 'burst.json')) || !existsSync(join(dir, 'k6.csv')))
    continue;
  const burst = readJson<any>(join(dir, 'burst.json'));
  const [header, ...lines] = parseCsv(
    readFileSync(join(dir, 'k6.csv'), 'utf8'),
  );
  const col = (name: string) => header.indexOf(name);
  const samples = lines
    .filter(
      (line) =>
        line[col('metric_name')] === 'http_req_duration' &&
        line[col('name')] === 'search',
    )
    .map((line) => ({
      t: Number(line[col('timestamp')]) * 1000,
      ms: Number(line[col('metric_value')]),
    }));
  const indexed = burst.documents
    .map((d: any) => d.indexedAfterMs)
    .filter((ms: number | null) => ms !== null) as number[];
  const drainedAt = burst.burstAt + Math.max(0, ...indexed);
  const phase = (from: number, to: number) =>
    samples.filter((s) => s.t >= from && s.t < to).map((s) => s.ms);
  const before = phase(burst.startedAt, burst.burstAt);
  const during = phase(burst.burstAt, drainedAt);
  const after = phase(drainedAt, Number.POSITIVE_INFINITY);
  md.push(
    `## burst — ${label}`,
    '',
    `${burst.documents.length} contracts uploaded at once, ${indexed.length} indexed; the last one ${fixed(Math.max(0, ...indexed) / 1000, 1)} s after the burst (median ${fixed(median(indexed) / 1000, 1)} s). Search load ${burst.vus} VUs throughout.`,
    '',
    '| phase | searches | p50 ms | p95 ms | p99 ms |',
    '|---|---|---|---|---|',
    ...(
      [
        ['before', before],
        ['during', during],
        ['after', after],
      ] as const
    ).map(
      ([name, values]) =>
        `| ${name} | ${values.length} | ${fixed(percentile([...values], 50))} | ${fixed(percentile([...values], 95))} | ${fixed(percentile([...values], 99))} |`,
    ),
    '',
  );
  const start = burst.startedAt;
  const windows = new Map<number, number[]>();
  for (const sample of samples) {
    const window = Math.floor((sample.t - start) / 1000 / WINDOW_S) * WINDOW_S;
    windows.set(window, [...(windows.get(window) ?? []), sample.ms]);
  }
  const queue = existsSync(join(dir, 'queue.jsonl'))
    ? readFileSync(join(dir, 'queue.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { t: number; ready: number; unacked: number },
        )
    : [];
  for (const [window, values] of [...windows].sort((a, b) => a[0] - b[0])) {
    const depth = queue.filter(
      (q) =>
        q.t - start >= window * 1000 &&
        q.t - start < (window + WINDOW_S) * 1000,
    );
    burstRows.push({
      label,
      second: window,
      searches: values.length,
      p50: percentile(values, 50).toFixed(1),
      p95: percentile(values, 95).toFixed(1),
      queue: depth.length
        ? Math.max(...depth.map((q) => (q.ready ?? 0) + (q.unacked ?? 0)))
        : '',
    });
  }
}

writeText(join(ROOT, 'summary.md'), `${md.join('\n')}\n`);
writeText(join(ROOT, 'summary.csv'), toCsv(medians));
if (burstRows.length) {
  writeText(join(ROOT, 'burst-series.csv'), toCsv(burstRows));
}
console.log(md.join('\n'));
