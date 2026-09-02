import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL nije postavljen');

export default defineConfig({
  schema: './libs/database/src/schema/index.ts',
  out: './libs/database/src/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
