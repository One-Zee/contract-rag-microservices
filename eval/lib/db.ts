import pg from 'pg';
import { requireEnv } from './env.ts';

/**
 * Direct SQL is for what the API deliberately does not offer — reading every
 * chunk of a document to label it, promoting the evaluation account, reading
 * the query log — never for anything a measured request does.
 */
export async function withDb<T>(
  fn: (client: pg.Pool) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({
    connectionString: requireEnv('DATABASE_URL'),
    max: 4,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
