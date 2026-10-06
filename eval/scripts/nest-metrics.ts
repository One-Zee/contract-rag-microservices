// The NestJS measurements of plan §9.5 that need no load:
//
//   - lines of code per service and library (cloc 1.98, pinned container);
//   - the auth flow as built in Nest against its Express twin, by role;
//   - the cost of changing the transport, from the commits that did it;
//   - how the existing tests use the DI container, and their coverage.
//
//   npm run eval:nest -- [--in-process <commit>…] [--rmq <commit>] [--coverage]
//
// Writes eval/results/nest/metrics.json and metrics.md.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import { EVAL_ROOT, REPO_ROOT } from '../lib/paths.ts';

const options = args();
const CLOC = 'aldanial/cloc:1.98';

interface Count {
  files: number;
  code: number;
  comment: number;
  blank: number;
}

/** Code lines of TypeScript, specs excluded, through the pinned container. */
function cloc(paths: string[]): Count {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${REPO_ROOT}:/src`,
      '-w',
      '/src',
      CLOC,
      '--json',
      '--quiet',
      '--include-lang=TypeScript',
      '--not-match-f=\\.spec\\.ts$',
      ...paths,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`cloc failed: ${result.stderr}`);
  }
  const sum = JSON.parse(result.stdout || '{}').SUM ?? {};
  return {
    files: sum.nFiles ?? 0,
    code: sum.code ?? 0,
    comment: sum.comment ?? 0,
    blank: sum.blank ?? 0,
  };
}

const list = (dir: string): string[] =>
  existsSync(join(REPO_ROOT, dir))
    ? readdirSync(join(REPO_ROOT, dir)).sort()
    : [];

// ── 1. Per service and library ───────────────────────────────────────────────
const perArea: Record<string, Count> = {};
for (const app of list('apps'))
  perArea[`apps/${app}`] = cloc([`apps/${app}/src`]);
for (const lib of list('libs'))
  perArea[`libs/${lib}`] = cloc([`libs/${lib}/src`]);
perArea.monolith = cloc(['monolith/src']);
perArea['bench/express-auth'] = cloc(['bench/express-auth/src']);

// ── 2. The auth flow: Nest as built vs the Express twin, by role ─────────────
// Shared libraries the twin also uses (config schemas, the Drizzle schema,
// telemetry) are counted on neither side. Roles:
//   wiring — modules, bootstraps, clients, transport: what splitting into
//            services and DI costs;
//   http   — controllers/routes, guards/middleware, DTOs and validation,
//            error mapping;
//   domain — what auth actually does: tokens, rotation, repositories.
const NEST_AUTH: Record<string, string[]> = {
  wiring: [
    'apps/auth-service/src/main.ts',
    'apps/auth-service/src/bootstrap.ts',
    'apps/auth-service/src/auth-service.module.ts',
    'apps/api-gateway/src/clients/auth-client.module.ts',
    'libs/common/src/contracts/auth.patterns.ts',
    'libs/common/src/auth/jwt-verifier.module.ts',
  ],
  http: [
    'apps/auth-service/src/auth.controller.ts',
    'apps/auth-service/src/registration-open.guard.ts',
    'apps/api-gateway/src/auth',
    'apps/api-gateway/src/users',
    'apps/api-gateway/src/common/rpc-to-http.ts',
    'libs/common/src/dto/auth.dto.ts',
    'libs/common/src/auth/roles.guard.ts',
    'libs/common/src/auth/roles.decorator.ts',
    'libs/common/src/auth/rpc-auth.guard.ts',
    'libs/common/src/auth/current-user.decorator.ts',
    'libs/common/src/auth/auth-context.ts',
    'libs/common/src/contracts/rpc-error.ts',
  ],
  domain: [
    'apps/auth-service/src/auth.service.ts',
    'apps/auth-service/src/token.service.ts',
    'apps/auth-service/src/repositories',
  ],
};
const EXPRESS_AUTH: Record<string, string[]> = {
  wiring: [
    'bench/express-auth/src/main.ts',
    'bench/express-auth/src/server.ts',
    'bench/express-auth/src/config.ts',
  ],
  http: ['bench/express-auth/src/routes.ts', 'bench/express-auth/src/http.ts'],
  domain: ['bench/express-auth/src/tokens.ts', 'bench/express-auth/src/db.ts'],
};
const existing = (paths: string[]) =>
  paths.filter((path) => existsSync(join(REPO_ROOT, path)));
const byRole = (roles: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(roles).map(([role, paths]) => [role, cloc(existing(paths))]),
  );
const nestAuth = byRole(NEST_AUTH);
const expressAuth = byRole(EXPRESS_AUTH);

/** Lines that are only OpenAPI documentation: `@Api…(` decorators, opening lines. */
function swaggerLines(paths: string[]): number {
  const files = spawnSync('git', ['ls-files', ...existing(paths)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
  return files.reduce(
    (sum, file) =>
      sum +
      readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .filter((line) => /^\s*@Api[A-Z]\w*\(/.test(line)).length,
    0,
  );
}
const nestSwagger = swaggerLines(Object.values(NEST_AUTH).flat());

// ── 3. The cost of changing the transport ────────────────────────────────────
interface Change {
  commit: string;
  subject: string;
  files: { path: string; added: number; removed: number }[];
}
function change(commit: string): Change {
  const subject = spawnSync('git', ['log', '-1', '--format=%s', commit], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).stdout.trim();
  const numstat = spawnSync('git', ['show', '--numstat', '--format=', commit], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).stdout;
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split('\t');
      return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
    });
  return { commit, subject, files };
}
const area = (path: string): string =>
  /^apps\/[^/]+\/src\/(main|bootstrap)\.ts$|^apps\/[^/]+\/src\/clients\//.test(
    path,
  )
    ? 'service wiring'
    : path.startsWith('apps/')
      ? 'service code'
      : path.startsWith('libs/rpc/')
        ? 'libs/rpc'
        : path.startsWith('libs/')
          ? 'other libs'
          : path.startsWith('monolith/')
            ? 'monolith composition'
            : path.startsWith('docker/') || path.startsWith('.env')
              ? 'deployment'
              : 'build and boundary config';
function summarizeChanges(commits: string[]) {
  const changes = commits.map(change);
  const totals: Record<
    string,
    { added: number; removed: number; files: number }
  > = {};
  for (const file of changes.flatMap((c) => c.files)) {
    const key = area(file.path);
    totals[key] ??= { added: 0, removed: 0, files: 0 };
    totals[key].added += file.added;
    totals[key].removed += file.removed;
    totals[key].files += 1;
  }
  return {
    commits: changes.map(({ commit, subject }) => ({ commit, subject })),
    totals,
  };
}
const multi = (name: string): string[] => {
  const value = options.get(name);
  return typeof value === 'string' ? value.split(',') : [];
};
const transport = {
  // Defaults: the monolith commit of phase 6, and the library commit that
  // added the in-process transport (in-process.ts is part of it).
  inProcess: summarizeChanges(
    multi('in-process').length ? multi('in-process') : ['f45d138'],
  ),
  rmq: multi('rmq').length ? summarizeChanges(multi('rmq')) : null,
  // The in-process transport itself landed in the library commit together
  // with the TCP tracing, so it is counted as a file rather than a diff.
  inProcessTransport: cloc(['libs/rpc/src/in-process.ts']),
  rmqTransport: cloc(
    existing([
      'libs/rpc/src/tracing-rmq.client.ts',
      'libs/rpc/src/tracing-rmq.server.ts',
    ]),
  ),
};

// ── 4. Tests: the DI container in the existing suites, and coverage ─────────
const specs = spawnSync('git', ['ls-files', '*.spec.ts'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .stdout.split('\n')
  .filter(Boolean);
const uses = (pattern: RegExp) =>
  specs.filter((file) =>
    pattern.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
  ).length;
const testing = {
  specFiles: specs.length,
  withTestingModule: uses(/Test\.createTestingModule/),
  withOverrideProvider: uses(/\.override(Provider|Guard|Pipe|Interceptor)\(/),
  withProviderValue: uses(/useValue:/),
  coverage: null as Record<string, unknown> | null,
};
if (options.has('coverage')) {
  spawnSync(
    'npx',
    ['vitest', 'run', '--coverage', '--coverage.reporter=json-summary'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );
  const file = join(REPO_ROOT, 'coverage', 'coverage-summary.json');
  if (existsSync(file)) {
    const summary = readJson<Record<string, any>>(file);
    const groups: Record<
      string,
      { statements: [number, number]; branches: [number, number] }
    > = {};
    for (const [path, entry] of Object.entries(summary)) {
      if (path === 'total') continue;
      const match = /\/(apps|libs)\/([^/]+)\//.exec(path);
      if (!match) continue;
      const key = `${match[1]}/${match[2]}`;
      groups[key] ??= { statements: [0, 0], branches: [0, 0] };
      groups[key].statements[0] += entry.statements.covered;
      groups[key].statements[1] += entry.statements.total;
      groups[key].branches[0] += entry.branches.covered;
      groups[key].branches[1] += entry.branches.total;
    }
    testing.coverage = {
      total: {
        statements: summary.total.statements.pct,
        branches: summary.total.branches.pct,
      },
      byArea: Object.fromEntries(
        Object.entries(groups).map(([key, g]) => [
          key,
          {
            statements:
              Math.round(
                (1000 * g.statements[0]) / Math.max(g.statements[1], 1),
              ) / 10,
            branches:
              Math.round((1000 * g.branches[0]) / Math.max(g.branches[1], 1)) /
              10,
          },
        ]),
      ),
    };
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
const out = join(EVAL_ROOT, 'results', 'nest');
writeJson(join(out, 'metrics.json'), {
  cloc: CLOC,
  perArea,
  nestAuth,
  expressAuth,
  nestSwagger,
  transport,
  testing,
});

const total = (roles: Record<string, Count>) =>
  Object.values(roles).reduce((sum, c) => sum + c.code, 0);
const md = [
  '# NestJS metrics (§9.5)',
  '',
  `Code lines (cloc ${CLOC.split(':')[1]}, TypeScript, specs excluded).`,
  '',
  '## Per service and library',
  '',
  '| area | files | code | comment |',
  '|---|---|---|---|',
  ...Object.entries(perArea).map(
    ([name, c]) => `| ${name} | ${c.files} | ${c.code} | ${c.comment} |`,
  ),
  '',
  '## Auth flow: Nest as built vs the Express twin',
  '',
  '| role | Nest code | Express code |',
  '|---|---|---|',
  ...Object.keys(NEST_AUTH).map(
    (role) =>
      `| ${role} | ${nestAuth[role].code} | ${expressAuth[role]?.code ?? 0} |`,
  ),
  `| **total** | **${total(nestAuth)}** | **${total(expressAuth)}** |`,
  '',
  `Of the Nest lines, ${nestSwagger} open an OpenAPI decorator (\`@Api…\`) — documentation the twin does not have.`,
  '',
  '## Changing the transport',
  '',
  `The in-process transport (\`libs/rpc/src/in-process.ts\`): ${transport.inProcessTransport.code} code lines; the RabbitMQ client and server: ${transport.rmqTransport.code}.`,
  '',
  ...Object.entries({ inProcess: transport.inProcess, rmq: transport.rmq })
    .filter(([, value]) => value)
    .flatMap(([name, value]) => [
      `### ${name}: ${value?.commits.map((c) => `${c.commit} ${c.subject}`).join('; ')}`,
      '',
      '| area | files | added | removed |',
      '|---|---|---|---|',
      ...Object.entries(value?.totals ?? {}).map(
        ([key, t]) => `| ${key} | ${t.files} | ${t.added} | ${t.removed} |`,
      ),
      '',
    ]),
  '## Tests and the DI container',
  '',
  `${testing.specFiles} spec files: ${testing.withTestingModule} build a Nest testing module, ${testing.withOverrideProvider} override a provider/guard, ${testing.withProviderValue} supply a provider by value.`,
  ...(testing.coverage
    ? ['', '```json', JSON.stringify(testing.coverage, null, 2), '```']
    : []),
];
writeText(join(out, 'metrics.md'), `${md.join('\n')}\n`);
console.log(md.join('\n'));
