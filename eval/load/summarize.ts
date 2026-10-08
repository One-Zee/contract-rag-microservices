// Turns eval/results/load/raw/ into the tables of §9.4 and §9.5:
// eval/results/load/summary.md and summary.csv (committed), plus a time
// series per burst run for the figure.
//
//   node eval/load/summarize.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, toCsv } from '../lib/csv.ts';
import { readJson, writeText } from '../lib/json.ts';
import { EVAL_ROOT } from '../lib/paths.ts';
import { percentile } from '../lib/stats.ts';
import type { Provenance } from './host.ts';

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

/** What run.json and burst.json record besides the run's own settings. */
type Origin = Partial<Provenance> & { stealPct?: number | null };

const rows: Row[] = [];
const invalid: string[] = [];
const origins: Origin[] = [];
const bursts: { label: string; rep: number; dir: string }[] = [];
for (const label of existsSync(RAW) ? readdirSync(RAW) : []) {
  const labelDir = join(RAW, label);
  if (label.startsWith('.') || label === 'smoke' || !isDirectory(labelDir))
    continue;
  for (const run of readdirSync(labelDir)) {
    const dir = join(labelDir, run);
    // `burst` before repetitions were numbered, `burst-r<n>` since.
    const burst = /^burst(?:-r(\d+))?$/.exec(run);
    if (burst) {
      bursts.push({ label, rep: Number(burst[1] ?? 1), dir });
      if (existsSync(join(dir, 'burst.json'))) {
        origins.push(readJson<Origin>(join(dir, 'burst.json')));
      }
      continue;
    }
    const match = /^(.*)-(\d+)vu-r(\d+)$/.exec(run);
    if (!match || !existsSync(join(dir, 'summary.json'))) continue;
    const summary = readJson<any>(join(dir, 'summary.json'));
    const meta = existsSync(join(dir, 'run.json'))
      ? readJson<{ duration: string; target?: string } & Origin>(
          join(dir, 'run.json'),
        )
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
    origins.push(meta);
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
  ...describeOrigins(origins),
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
const PHASES = ['before', 'during', 'after'] as const;
interface BurstRun {
  vus: number;
  uploaded: number;
  indexed: number[];
  phases: Record<(typeof PHASES)[number], number[]>;
}
const burstRuns = new Map<string, BurstRun[]>();
for (const { label, rep, dir } of bursts.sort((a, b) => a.rep - b.rep)) {
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
  burstRuns.set(label, [
    ...(burstRuns.get(label) ?? []),
    {
      vus: burst.vus,
      uploaded: burst.documents.length,
      indexed,
      phases: {
        before: phase(burst.startedAt, burst.burstAt),
        during: phase(burst.burstAt, drainedAt),
        after: phase(drainedAt, Number.POSITIVE_INFINITY),
      },
    },
  ]);
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
      rep,
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
// Each repetition is summarised on its own, then the median of those figures
// is taken, as for the runs above — pooling the samples would let the longest
// repetition decide.
for (const [label, runs] of burstRuns) {
  const across = (pick: (run: BurstRun) => number) => median(runs.map(pick));
  const at = (values: number[], p: number) =>
    values.length ? percentile([...values], p) : Number.NaN;
  md.push(
    `## burst — ${label}`,
    '',
    `${runs[0].uploaded} contracts uploaded at once, under a search load of ${runs[0].vus} VUs throughout; medians over ${runs.length} repetition${runs.length === 1 ? '' : 's'}. The last contract indexed ${fixed(across((run) => Math.max(0, ...run.indexed)) / 1000, 1)} s after the burst (median contract ${fixed(across((run) => at(run.indexed, 50)) / 1000, 1)} s), ${fixed(across((run) => run.indexed.length))} of ${runs[0].uploaded} indexed.`,
    '',
    '| phase | n | searches | p50 ms | p95 ms | p99 ms |',
    '|---|---|---|---|---|---|',
    ...PHASES.map(
      (name) =>
        `| ${name} | ${runs.length} | ${fixed(across((run) => run.phases[name].length))} | ${fixed(across((run) => at(run.phases[name], 50)))} | ${fixed(across((run) => at(run.phases[name], 95)))} | ${fixed(across((run) => at(run.phases[name], 99)))} |`,
    ),
    '',
  );
}

writeText(join(ROOT, 'summary.md'), `${md.join('\n')}\n`);
writeText(join(ROOT, 'summary.csv'), toCsv(medians));
if (burstRows.length) {
  writeText(join(ROOT, 'burst-series.csv'), toCsv(burstRows));
}
console.log(md.join('\n'));

function isDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}

/**
 * Where the numbers come from: the machine, the commit and the image of every
 * run, and the most CPU a hypervisor took from any of them. A series that
 * mixes machines or commits is flagged here, not averaged quietly.
 */
function describeOrigins(all: Origin[]): string[] {
  const distinct = (describe: (origin: Origin) => string) => {
    const counts = new Map<string, number>();
    for (const origin of all) {
      const key = describe(origin);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts];
  };
  const machine = (origin: Origin) =>
    origin.docker
      ? `${origin.docker.cpus} CPUs and ${origin.docker.memoryGiB} GiB for Docker (${origin.docker.os}, kernel ${origin.docker.kernel}, Docker ${origin.docker.version}) on ${origin.host?.cpu ?? 'an unknown CPU'}`
      : 'not recorded';
  const commit = (origin: Origin) =>
    origin.commit
      ? `${origin.commit}${origin.dirty ? ' with uncommitted changes' : ''}`
      : 'not recorded';
  const image = (origin: Origin) =>
    origin.image
      ? origin.image.replace(/^sha256:/, '').slice(0, 12)
      : 'not recorded';
  const line = (name: string, values: [string, number][]) =>
    values.length === 1
      ? `- ${name}: ${values[0][0]}`
      : `- ${name} — **mixed**, ${values.map(([value, n]) => `${value} (${n} runs)`).join('; ')}`;
  const steal = all
    .map((origin) => origin.stealPct)
    .filter((value): value is number => typeof value === 'number');
  return [
    `Provenance of the ${all.length} runs:`,
    '',
    line('machine', distinct(machine)),
    line('commit', distinct(commit)),
    line('image', distinct(image)),
    `- CPU steal: ${steal.length ? `at most ${Math.max(...steal).toFixed(2)} % of CPU time in any run (${steal.length} measured)` : 'not measured (only on a Linux host)'}`,
  ];
}
