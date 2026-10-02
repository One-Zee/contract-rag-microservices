// Applies libs/database/src/migrations to DATABASE_URL — the container
// counterpart of `npm run db:migrate`, run once by the `migrate` service
// before anything that uses the database starts .
//
// drizzle-kit is a dev dependency and stays out of the image. drizzle-orm's
// migrator reads the same journal and records progress in the same table
// (`drizzle.__drizzle_migrations`), so a database migrated by either one is
// up to date for the other. Never `drizzle-kit push` — see CLAUDE.md.
//
// Plain JavaScript on purpose: it runs from the runtime image, where there is
// no TypeScript and no bundler, and it is short enough not to need either.
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: 'libs/database/src/migrations',
  });
  console.log('Migrations are up to date');
} finally {
  await pool.end();
}
