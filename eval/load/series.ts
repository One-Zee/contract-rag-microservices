// The whole load series in one command: every topology, scenario and
// repetition behind the load tables, unattended, in an order that spreads the
// host's drift over all of them.
//
//   npm run load:series [-- --reps 3] [--topologies services,monolith,budget]
//        [--vus 10,50,100] [--duration 60s] [--burst-duration 240s]
//        [--skip-burst] [--skip-overhead] [--dry-run] [--allow-dirty]
//
// Repetition r runs the topologies rotated by r - 1, so none is always first:
// a host that warms up, throttles or gets busier over the hours shows up in
// every topology alike. Each step is one run-load.ts command, logged with its
// start, end and outcome in raw/; the first failure stops the series. The
// tables are written at the end (summarize.ts).
//
// The matrix: search and query at three levels in every topology, the
// indexing burst in the evenly split services and the monolith, and the
// framework overhead against the services, the Express twin and the 1-CPU
// monolith. The budget topology only answers searches and questions — a burst
// there would measure ingestion's eighth of a CPU.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { args, loadEnv } from '../lib/env.ts';
import { EVAL_ROOT, REPO_ROOT } from '../lib/paths.ts';
import { isDirty } from './host.ts';

loadEnv();
const options = args();
const RAW = join(EVAL_ROOT, 'results', 'load', 'raw');

const reps = Number(options.get('reps') ?? 3);
const topologies = String(
  options.get('topologies') ?? 'services,monolith,budget',
).split(',');
const vus = String(options.get('vus') ?? '10,50,100');
const duration = String(options.get('duration') ?? '60s');
const seconds = Number.parseFloat(duration) * (duration.endsWith('m') ? 60 : 1);
// A trial series shortens this too; the burst itself starts a minute in.
const burstDuration = String(options.get('burst-duration') ?? '240s');

const OVERHEAD_ENDPOINTS = ['health', 'me', 'user', 'login'];
// A login is a bcrypt hash: ten users already keep one CPU busy.
const overheadVus = (endpoint: string) => (endpoint === 'login' ? '10' : '50');
const OVERHEAD_TARGETS = [
  ['express-1cpu', 'http://express-auth:3100'],
  ['monolith-1cpu', 'http://monolith:3000'],
];
const BURSTS = new Set(['services', 'monolith']);

interface Step {
  args: string[];
  /** Seconds, for the estimate only. */
  estimate: number;
}
const steps: Step[] = [];
const step = (estimate: number, ...stepArgs: string[]) =>
  steps.push({ args: stepArgs, estimate });
// Per level: a 15-second warm-up, the run, then k6's start, setup and pause.
const levels = (count: number) => count * (15 + seconds + 20);

// Whatever an earlier session left up goes first: `up` would merge over it.
if (existsSync(join(RAW, '.state.json'))) {
  step(30, 'down');
}
let seeded = false;
for (let rep = 1; rep <= reps; rep++) {
  const shift = (rep - 1) % topologies.length;
  const order = [...topologies.slice(shift), ...topologies.slice(0, shift)];
  const repArgs = ['--rep', String(rep), '--reps', '1'];
  for (const topology of order) {
    // The first `up` builds the image from this checkout; the rest reuse it.
    step(seeded ? 90 : 300, 'up', topology, ...(seeded ? [] : ['--build']));
    if (!seeded) {
      // Once: the corpus stays in the database volume across `down`.
      step(900, 'seed');
      seeded = true;
    }
    for (const scenario of ['search', 'query']) {
      step(
        levels(vus.split(',').length),
        'run',
        scenario,
        '--label',
        topology,
        '--vus',
        vus,
        '--duration',
        duration,
        ...repArgs,
      );
    }
    if (BURSTS.has(topology) && !options.has('skip-burst')) {
      step(
        Number.parseFloat(burstDuration) + 90,
        'burst',
        '--label',
        topology,
        '--rep',
        String(rep),
        '--duration',
        burstDuration,
      );
    }
    if (topology === 'services' && !options.has('skip-overhead')) {
      for (const endpoint of OVERHEAD_ENDPOINTS) {
        step(
          levels(1),
          'run',
          'overhead',
          '--label',
          'services',
          '--endpoint',
          endpoint,
          '--vus',
          overheadVus(endpoint),
          '--duration',
          duration,
          ...repArgs,
        );
      }
    }
    step(30, 'down');
  }
  if (!options.has('skip-overhead')) {
    step(90, 'up', 'monolith', '--bench', '--overhead');
    for (const [label, target] of OVERHEAD_TARGETS) {
      for (const endpoint of OVERHEAD_ENDPOINTS) {
        step(
          levels(1),
          'run',
          'overhead',
          '--label',
          label,
          '--target',
          target,
          '--endpoint',
          endpoint,
          '--vus',
          overheadVus(endpoint),
          '--duration',
          duration,
          ...repArgs,
        );
      }
    }
    step(30, 'down');
  }
}

const total = steps.reduce((sum, { estimate }) => sum + estimate, 0);
console.log(
  `${steps.length} steps, about ${(total / 3600).toFixed(1)} h ` +
    `(${reps} repetitions of ${topologies.join(', ')})`,
);
if (options.has('dry-run')) {
  for (const { args: stepArgs } of steps) {
    console.log(`  run-load.ts ${stepArgs.join(' ')}`);
  }
  process.exit(0);
}
if (isDirty() && !options.has('allow-dirty')) {
  throw new Error(
    'Tracked files differ from HEAD, so the commit every run records would ' +
      'not reproduce the numbers. Commit first, or pass --allow-dirty for a ' +
      'trial run.',
  );
}

// One wake lock for the whole series: the moment between two orchestrator
// commands is enough for a laptop to fall asleep (see run-load.ts).
if (process.platform === 'darwin') {
  spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();
}

mkdirSync(RAW, { recursive: true });
const log = join(
  RAW,
  `series-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
);
const note = (line: string) => {
  const text = `${new Date().toISOString()} ${line}`;
  appendFileSync(log, `${text}\n`);
  console.log(text);
};

for (const [index, { args: stepArgs }] of steps.entries()) {
  note(`[${index + 1}/${steps.length}] run-load.ts ${stepArgs.join(' ')}`);
  const startedAt = Date.now();
  const result = spawnSync('node', ['eval/load/run-load.ts', ...stepArgs], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const took = `${((Date.now() - startedAt) / 1000).toFixed(0)} s`;
  if (result.status !== 0) {
    note(
      `failed after ${took} (${result.signal ?? `exit ${result.status}`}); ` +
        'the series stops here — `node eval/load/run-load.ts down` clears what is up',
    );
    process.exit(1);
  }
  note(`done in ${took}`);
}
spawnSync('node', ['eval/load/summarize.ts'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
note('series complete: eval/results/load/summary.md');
