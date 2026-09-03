import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL nije postavljen');

// NIKAD `drizzle-kit push` — push regeneriše HNSW indeks bez operatorske klase
// i Postgres odbije CREATE INDEX. Samo `generate` → `migrate`.
export default defineConfig({
  schema: './libs/database/src/schema/index.ts',
  out: './libs/database/src/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
