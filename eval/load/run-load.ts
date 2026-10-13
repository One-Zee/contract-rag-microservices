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
import {
  cpuTicks,
  imageId,
  keepAwake,
  powershell,
  provenance,
  stealPct,
} from './host.ts';

loadEnv();
const options = args();
const [command, subject] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'));
const RESULTS = join(EVAL_ROOT, 'results', 'load', 'raw');
const STATE = join(RESULTS, '.state.json');
const LOAD_DB = process.env.LOAD_DB ?? 'contracts_load';
const LOAD_EMAIL = process.env.LOAD_EMAIL ?? 'load@clauseiq.test';
const LOAD_PASSWORD = process.env.LOAD_PASSWORD ?? 'load-test-only-password';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function budget(topology: string, overhead: boolean): Record<string, string> {
  const pick = (name: string, fallback: string) =>
    process.env[name] ?? fallback;
  const monolithCpus = pick('MONOLITH_CPUS', '3');
  return {
    SERVICE_CPUS: pick('SERVICE_CPUS', '0.5'),
    SERVICE_MEMORY: pick('SERVICE_MEMORY', '256M'),
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
  image: string | null;
}

keepAwake();

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
    const built = spawnSync('npm run image:build', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true,
    });
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

function localListeners(): string[] {
  if (process.platform === 'win32') {
    return (
      powershell(
        "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess; '{0} pid {1}' -f $p.ProcessName, $p.Id }",
      ) ?? ''
    )
      .split(/\r?\n/)
      .filter((line) => /^node\b/i.test(line.trim()));
  }
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:3000', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  return lsof.error
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
}

function assertNoLocalGateway(): void {
  const local = localListeners();
  if (local.length > 0) {
    throw new Error(
      `A local process listens on port 3000 — stop npm run dev first:\n${local.join('\n')}`,
    );
  }
}

async function seed(): Promise<void> {
  assertNoLocalGateway();
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

function sampleStats(file: string): ChildProcess {
  const out = createWriteStream(file);
  const child = spawn('docker', ['stats', '--format', '{{json .}}']);
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
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
      } catch {}
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
