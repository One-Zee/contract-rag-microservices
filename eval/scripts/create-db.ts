// Creates the evaluation database DATABASE_URL names, if missing, and brings
// it to the latest migration (docker/migrate.mjs — the same migrator the
// containers use; never drizzle-kit push).
//
//   DATABASE_URL=postgresql://app:dev@localhost:5432/contracts_eval npm run eval:db
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { loadEnv, requireEnv } from '../lib/env.ts';
import { REPO_ROOT } from '../lib/paths.ts';

loadEnv();
const target = new URL(requireEnv('DATABASE_URL'));
const name = decodeURIComponent(target.pathname.replace(/^\//, ''));

// One corpus per database. The development database holds other
// people's shared documents, which would enter every corpus-wide search.
if (!/^contracts_[a-z0-9_]+$/.test(name)) {
  throw new Error(
    `Refusing "${name}": evaluation databases are named contracts_<experiment>`,
  );
}

const admin = new URL(target);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const exists = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (exists.rowCount === 0) {
    // An identifier cannot be a bind parameter; the regex above is the guard.
    await client.query(`CREATE DATABASE "${name}"`);
    console.log(`Created database ${name}`);
  } else {
    console.log(`Database ${name} exists`);
  }
} finally {
  await client.end();
}

const migrate = spawnSync('node', ['docker/migrate.mjs'], {
  cwd: REPO_ROOT,
  env: { ...process.env, DATABASE_URL: target.toString() },
  stdio: 'inherit',
});
if (migrate.status !== 0) {
  throw new Error('Migration failed');
}
