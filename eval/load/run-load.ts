// The load-test orchestrator. Every number of §9.4 comes out of
// this script, on any host with Docker — the same commands produce the final
// figures on Linux.
//
//   node eval/load/run-load.ts up <services|budget|rmq|monolith> [--bench] [--overhead] [--build]
//   node eval/load/run-load.ts seed
//   node eval/load/run-load.ts run <search|query|overhead> --label <name>
//        [--vus 10,50,100] [--reps 3] [--rep 1] [--duration 60s] [--target <url>] [--endpoint health]
//   node eval/load/run-load.ts burst --label <name> [--rep 1] [--vus 20] [--uploads 40] [--duration 240s]
//   node eval/load/run-load.ts down
//
// Results land in eval/results/load/raw/<label>/…; summarize.ts turns them
// into tables. `--rep` numbers the first repetition, so a series that comes
// back to a topology (series.ts) adds repetitions instead of overwriting them.
// Never alongside `npm run dev`, stack:up or monolith:up.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Gateway } from '../lib/api.ts';
import { pdfPath } from '../lib/cuad.ts';
import { loadContracts } from '../lib/dataset.ts';
import { args, loadEnv } from '../lib/env.ts';
import { readJson, writeJson } from '../lib/json.ts';
import { CONTRACTS_FILE, EVAL_ROOT, REPO_ROOT } from '../lib/paths.ts';
import { cpuTicks, imageId, provenance, stealPct } from './host.ts';

loadEnv();
const options = args();
const [command, subject] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'));
// Raw run output is gitignored; summarize.ts writes the committed tables one
// level up, in eval/results/load/.
const RESULTS = join(EVAL_ROOT, 'results', 'load', 'raw');
const STATE = join(RESULTS, '.state.json');
const LOAD_DB = process.env.LOAD_DB ?? 'contracts_load';
const LOAD_EMAIL = process.env.LOAD_EMAIL ?? 'load@clauseiq.test';
const LOAD_PASSWORD = process.env.LOAD_PASSWORD ?? 'load-test-only-password';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The resource budget: equal totals per topology. Defaults fit a
 * Docker VM of 8 CPUs and 3.8 GB; every value can be overridden from the
 * environment, and the run records what it used — the settings that change
 * what a search does included.
 */
function budget(topology: string, overhead: boolean): Record<string, string> {
  const pick = (name: string, fallback: string) =>
    process.env[name] ?? fallback;
  const monolithCpus = pick('MONOLITH_CPUS', '3');
  return {
    SERVICE_CPUS: pick('SERVICE_CPUS', '0.5'),
    SERVICE_MEMORY: pick('SERVICE_MEMORY', '256M'),
    // The overhead runs compare one process with one process.
    MONOLITH_CPUS: overhead ? pick('OVERHEAD_CPUS', '1') : monolithCpus,
    MONOLITH_MEMORY: overhead
      ? pick('OVERHEAD_MEMORY', '512M')
      : pick('MONOLITH_MEMORY', '1536M'),
    OVERHEAD_CPUS: pick('OVERHEAD_CPUS', '1'),
    OVERHEAD_MEMORY: pick('OVERHEAD_MEMORY', '512M'),
    ...(topology === 'budget' ? perServiceCpus(monolithCpus) : {}),
    LEXICAL_MATCH: pick('LEXICAL_MATCH', 'all'),
    LOAD_RERANK: pick('LOAD_RERANK', 'none'),
    LOAD_DB,
    ...stubLatencies(),
  };
}

/**
 * The `budget` topology: the six services with the monolith's total, split
 * by the work each does under search and query load rather than evenly — what
 * scaling one service independently buys. The total must stay the
 * monolith's, or the comparison is between budgets, not topologies.
 */
function perServiceCpus(total: string): Record<string, string> {
  const split: Record<string, string> = {
    BUDGET_GATEWAY_CPUS: process.env.BUDGET_GATEWAY_CPUS ?? '0.5',
    BUDGET_AUTH_CPUS: process.env.BUDGET_AUTH_CPUS ?? '0.25',
    BUDGET_INGESTION_CPUS: process.env.BUDGET_INGESTION_CPUS ?? '0.125',
    BUDGET_INDEXING_CPUS: process.env.BUDGET_INDEXING_CPUS ?? '0.125',
    BUDGET_RETRIEVAL_CPUS: process.env.BUDGET_RETRIEVAL_CPUS ?? '1.25',
    BUDGET_LLM_CPUS: process.env.BUDGET_LLM_CPUS ?? '0.75',
  };
  const sum = Object.values(split).reduce((a, b) => a + Number(b), 0);
  if (Math.abs(sum - Number(total)) > 1e-9) {
    throw new Error(
      `The per-service CPUs add up to ${sum}, the monolith has ${total}`,
    );
  }
  return split;
}

/**
 * The stub's latencies from calibrate-stub.ts, when it has run; the stub's
 * placeholder defaults otherwise. Either way they are recorded with the run.
 */
function stubLatencies(): Record<string, string> {
  const file = join(EVAL_ROOT, 'results', 'load', 'stub.env');
  if (!existsSync(file)) {
    return {};
  }
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^STUB_[A-Z_]+=/.test(line))
      .map((line) => line.split('=') as [string, string])
      .filter(([key]) => process.env[key] === undefined),
  );
}

interface State {
  topology: string;
  files: string[];
  env: Record<string, string>;
  target: string;
  /** The image under test, by content. */
  image: string | null;
}

/**
 * A laptop that idle-sleeps mid-run stretches every request in flight by the
 * length of the nap — the first local runs measured 40-second logins that
 * were 42 seconds of sleep. On macOS the orchestrator keeps the machine awake
 * for as long as it runs (lid-close sleep it cannot stop: plug in, keep it
 * open); summarize.ts still rejects any run that took far longer than planned.
 * `unref()` is load-bearing: caffeinate waits for this process to exit, and a
 * referenced child would keep this process waiting for caffeinate.
 */
if (process.platform === 'darwin') {
  spawn('caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
  })
    .on('error', () => undefined)
    .unref();
}

/** "AC Power" or "Battery Power" on macOS — a laptop on battery may run slower. */
function powerSource(): string | null {
  if (process.platform !== 'darwin') return null;
  const out = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout;
  return /'([^']+)'/.exec(out)?.[1] ?? null;
}

function compose(
  state: Pick<State, 'files' | 'env'>,
  composeArgs: string[],
  inherit = true,
) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      ...state.files.flatMap((file) => ['-f', file]),
      ...composeArgs,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...state.env },
      stdio: inherit ? 'inherit' : 'pipe',
      encoding: 'utf8',
    },
  );
  // 99 is k6 reporting a crossed threshold (errors above 1 %): under enough
  // load that is the result being measured, not a failure of the run.
  const k6Threshold =
    composeArgs[composeArgs.indexOf('k6') + 1] === 'run' &&
    result.status === 99;
  if (result.status !== 0 && !k6Threshold) {
    throw new Error(`docker compose ${composeArgs.join(' ')} failed`);
  }
  return result;
}

function files(topology: string, bench: boolean): string[] {
  const base = [
    'docker/docker-compose.yaml',
    'docker/docker-compose.observability.yaml',
  ];
  const byTopology: Record<string, string[]> = {
    services: [
      'docker/docker-compose.services.yaml',
      'docker/docker-compose.load.yaml',
      'docker/docker-compose.load.services.yaml',
    ],
    budget: [
      'docker/docker-compose.services.yaml',
      'docker/docker-compose.load.yaml',
      'docker/docker-compose.load.services.yaml',
      'docker/docker-compose.load.budget.yaml',
    ],
    rmq: [
      'docker/docker-compose.services.yaml',
      'docker/docker-compose.load.yaml',
      'docker/docker-compose.load.services.yaml',
      'docker/docker-compose.load.rmq.yaml',
    ],
    monolith: [
      'docker/docker-compose.monolith.yaml',
      'docker/docker-compose.load.yaml',
      'docker/docker-compose.load.monolith.yaml',
    ],
  };
  if (!byTopology[topology]) {
    throw new Error(
      `Unknown topology "${topology}": services, budget, rmq or monolith`,
    );
  }
  return [
    ...base,
    ...byTopology[topology],
    ...(bench ? ['docker/docker-compose.bench.yaml'] : []),
  ];
}

const readState = (): State => {
  if (!existsSync(STATE)) {
    throw new Error('Nothing is up — run `up` first');
  }
  return readJson<State>(STATE);
};

async function up(): Promise<void> {
  assertNoLocalGateway();
  const topology = subject ?? 'services';
  const env = budget(topology, options.has('overhead'));
  if (
    options.has('build') ||
    spawnSync('docker', ['image', 'inspect', 'clauseiq:local']).status !== 0
  ) {
    const built = spawnSync('npm', ['run', 'image:build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    // Going on would measure whatever image was built last.
    if (built.status !== 0) {
      throw new Error('The image did not build');
    }
  }
  const state: State = {
    topology,
    files: files(topology, options.has('bench')),
    env,
    target:
      topology === 'monolith'
        ? 'http://monolith:3000'
        : 'http://api-gateway:3000',
    image: imageId('clauseiq:local'),
  };
  // The database must exist before the migrate service runs against it.
  compose({ files: ['docker/docker-compose.yaml'], env }, [
    'up',
    '-d',
    '--wait',
    'postgres',
  ]);
  const created = spawnSync('node', ['eval/scripts/create-db.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://app:dev@localhost:5432/${LOAD_DB}`,
    },
    stdio: 'inherit',
  });
  if (created.status !== 0) {
    throw new Error('Could not create the load database');
  }
  compose(state, ['up', '-d', '--wait', '--remove-orphans']);
  mkdirSync(RESULTS, { recursive: true });
  writeJson(STATE, state);
  console.log(`${topology} is up (${JSON.stringify(env)})`);
}

/**
 * A local `npm run dev` gateway and the container can both listen on port
 * 3000 (one on ::1, one on 127.0.0.1), and `localhost` then reaches the local
 * one — a whole run against the wrong system, without an error.
 */
function assertNoLocalGateway(): void {
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:3000', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  // A minimal Linux host may have no lsof; ss lists the same listeners there.
  const local = lsof.error
    ? (
        spawnSync('ss', ['-ltnpH', 'sport = :3000'], { encoding: 'utf8' })
          .stdout ?? ''
      )
        .split('\n')
        .filter((line) => line.includes('"node"'))
    : lsof.stdout
        .split('\n')
        .slice(1)
        .filter((line) => /^node\s/.test(line));
  if (local.length > 0) {
    throw new Error(
      `A local process listens on port 3000 — stop npm run dev first:\n${local.join('\n')}`,
    );
  }
}

async function seed(): Promise<void> {
  assertNoLocalGateway();
  // The load account must exist and may upload; setup-corpus does both.
  const extra = join(EVAL_ROOT, 'dataset', 'load-contracts.json');
  const result = spawnSync(
    'node',
    [
      'eval/scripts/setup-corpus.ts',
      '--contracts',
      [CONTRACTS_FILE, extra].join(','),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://app:dev@localhost:5432/${LOAD_DB}`,
        EVAL_EMAIL: LOAD_EMAIL,
        EVAL_PASSWORD: LOAD_PASSWORD,
        GATEWAY_URL: 'http://localhost:3000',
      },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error('Seeding failed');
  }
}

/**
 * `docker stats` for the whole run, one JSON line per container per refresh.
 * `t` is when the line arrived, not when it was measured: into a pipe the
 * refreshes come in a few large chunks, so summarize.ts works per container.
 */
function sampleStats(file: string): ChildProcess {
  const out = createWriteStream(file);
  const child = spawn('docker', ['stats', '--format', '{{json .}}']);
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    // `docker stats` clears the screen between refreshes even into a pipe.
    // oxlint-disable-next-line no-control-regex
    buffer += chunk.toString('utf8').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const start = line.indexOf('{');
      if (start === -1) continue;
      try {
        const row = JSON.parse(line.slice(start));
        const [used] = String(row.MemUsage).split('/');
        out.write(
          `${JSON.stringify({ t: Date.now(), name: row.Name, cpu: parseFloat(row.CPUPerc), mem: used.trim() })}\n`,
        );
      } catch {
        // a partial line; the next refresh repeats it
      }
    }
  });
  return child;
}

function k6(
  state: State,
  script: string,
  out: string,
  env: Record<string, string>,
  extra: string[] = [],
) {
  mkdirSync(join(RESULTS, out), { recursive: true, mode: 0o777 });
  const vars = {
    BASE_URL: env.BASE_URL ?? state.target,
    LOAD_EMAIL,
    LOAD_PASSWORD,
    OUT: out,
    ...env,
  };
  return [
    'run',
    '--rm',
    '--no-deps',
    ...Object.entries(vars).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]),
    'k6',
    'run',
    '--quiet',
    ...extra,
    `/scripts/${script}`,
  ];
}

async function run(): Promise<void> {
  const state = readState();
  const scenario = subject;
  if (!['search', 'query', 'overhead'].includes(scenario ?? '')) {
    throw new Error('run <search|query|overhead>');
  }
  const label = String(options.get('label') ?? state.topology);
  const levels = String(options.get('vus') ?? '10,50,100')
    .split(',')
    .map(Number);
  const reps = Number(options.get('reps') ?? 3);
  const firstRep = Number(options.get('rep') ?? 1);
  const duration = String(options.get('duration') ?? '60s');
  const endpoint = String(options.get('endpoint') ?? 'health');
  const target = options.get('target')
    ? String(options.get('target'))
    : state.target;
  const name =
    scenario === 'overhead' ? `overhead-${endpoint}` : (scenario as string);

  for (const vus of levels) {
    // A short warm-up per level: JIT, connection pools, the HNSW pages.
    compose(
      state,
      k6(state, `${scenario}.js`, `${label}/warmup`, {
        BASE_URL: target,
        VUS: String(Math.min(vus, 10)),
        DURATION: '15s',
        ENDPOINT: endpoint,
      }),
    );
    for (let rep = firstRep; rep < firstRep + reps; rep++) {
      const out = `${label}/${name}-${vus}vu-r${rep}`;
      mkdirSync(join(RESULTS, out), { recursive: true });
      const sampler = sampleStats(join(RESULTS, out, 'stats.jsonl'));
      const ticks = cpuTicks();
      const startedAt = Date.now();
      try {
        compose(
          state,
          k6(state, `${scenario}.js`, out, {
            BASE_URL: target,
            VUS: String(vus),
            DURATION: duration,
            ENDPOINT: endpoint,
          }),
        );
      } finally {
        sampler.kill();
      }
      writeJson(join(RESULTS, out, 'run.json'), {
        topology: state.topology,
        scenario: name,
        vus,
        rep,
        duration,
        target,
        budget: state.env,
        at: new Date(startedAt).toISOString(),
        wallMs: Date.now() - startedAt,
        power: powerSource(),
        stealPct: stealPct(ticks, cpuTicks()),
        ...provenance(state.image),
      });
      await sleep(5000);
    }
  }
}

/**
 * Plan §9.4: what happens when indexing is swamped. A steady search load runs
 * throughout; a minute in, a batch of contracts is uploaded at once. Recorded:
 * search latency over time (k6 CSV), the indexing queue depth, and how long
 * each document took from upload to indexed.
 */
async function burst(): Promise<void> {
  assertNoLocalGateway();
  const state = readState();
  const label = String(options.get('label') ?? state.topology);
  const vus = String(options.get('vus') ?? '20');
  const uploads = Number(options.get('uploads') ?? 40);
  const duration = String(options.get('duration') ?? '240s');
  const rep = Number(options.get('rep') ?? 1);
  const out = `${label}/burst-r${rep}`;
  const dir = join(RESULTS, out);
  mkdirSync(dir, { recursive: true, mode: 0o777 });

  const gateway = new Gateway('http://localhost:3000');
  await gateway.login(LOAD_EMAIL, LOAD_PASSWORD);
  const contracts = loadContracts().slice(0, uploads);

  const sampler = sampleStats(join(dir, 'stats.jsonl'));
  const ticks = cpuTicks();
  const queue = createWriteStream(join(dir, 'queue.jsonl'));
  const queueTimer = setInterval(() => {
    fetch('http://localhost:15672/api/queues/%2F/indexing', {
      headers: {
        authorization: `Basic ${Buffer.from('guest:guest').toString('base64')}`,
      },
    })
      .then((response) => response.json())
      .then((body: any) => {
        queue.write(
          `${JSON.stringify({ t: Date.now(), ready: body.messages_ready, unacked: body.messages_unacknowledged })}\n`,
        );
      })
      .catch(() => undefined);
  }, 1000);

  const load = spawn(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      ...state.files.flatMap((f) => ['-f', f]),
      ...k6(state, 'search.js', out, { VUS: vus, DURATION: duration }, [
        '--out',
        `csv=/results/${out}/k6.csv`,
      ]),
    ],
    { cwd: REPO_ROOT, env: { ...process.env, ...state.env }, stdio: 'inherit' },
  );
  // Listened for from the start: k6 may finish before indexing does, and an
  // `exit` that has already happened is never delivered to a later listener.
  const loadDone = new Promise((resolve) => load.on('exit', resolve));
  const startedAt = Date.now();
  await sleep(60_000);

  const burstAt = Date.now();
  const documents: {
    contract: string;
    id: string;
    uploadMs: number;
    indexedAt?: number;
    status?: string;
  }[] = [];
  const pending = [...contracts];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const sent = Date.now();
        const document = await gateway.upload(
          pdfPath(next),
          `burst ${next.id}`,
        );
        documents.push({
          contract: next.id,
          id: document.id,
          uploadMs: Date.now() - sent,
        });
      }
    }),
  );
  while (
    documents.some((d) => !d.indexedAt) &&
    Date.now() - burstAt < 20 * 60_000
  ) {
    for (const document of documents.filter((d) => !d.indexedAt)) {
      const status = await gateway.status(document.id);
      if (status.status === 'indexed' || status.status === 'failed') {
        document.indexedAt = Date.now();
        document.status = status.status;
      }
    }
    await sleep(1000);
  }
  await loadDone;
  clearInterval(queueTimer);
  queue.end();
  sampler.kill();

  writeJson(join(dir, 'burst.json'), {
    topology: state.topology,
    rep,
    vus: Number(vus),
    duration,
    budget: state.env,
    stealPct: stealPct(ticks, cpuTicks()),
    ...provenance(state.image),
    startedAt,
    burstAt,
    documents: documents.map((d) => ({
      ...d,
      indexedAfterMs: d.indexedAt ? d.indexedAt - burstAt : null,
    })),
  });
  // The next burst must start from the same corpus.
  for (const document of documents) {
    await fetch(`http://localhost:3000/documents/${document.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${gateway.token}` },
    });
  }
  console.log(
    `burst: ${documents.length} documents, ${documents.filter((d) => d.status === 'indexed').length} indexed`,
  );
}

function down(): void {
  const state = readState();
  compose(state, ['--profile', 'k6', 'down', '--remove-orphans']);
  rmSync(STATE, { force: true });
}

const commands: Record<string, () => Promise<void> | void> = {
  up,
  seed,
  run,
  burst,
  down,
};
const handler = commands[command ?? ''];
if (!handler) {
  throw new Error(`Commands: ${Object.keys(commands).join(', ')}`);
}
await handler();
