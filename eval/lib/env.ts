import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.ts';

/**
 * Loads `.env` without overriding what the shell already set, the same
 * precedence the services have — so `DATABASE_URL=… node eval/…` points a
 * script at an evaluation database while the keys still come from `.env`.
 */
export function loadEnv(): void {
  const file = join(REPO_ROOT, '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export const gatewayUrl = (): string =>
  (process.env.GATEWAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** The database name doubles as the experiment name: one corpus per database. */
export function experimentName(): string {
  if (process.env.EVAL_EXPERIMENT) {
    return process.env.EVAL_EXPERIMENT;
  }
  const url = new URL(requireEnv('DATABASE_URL'));
  return url.pathname.replace(/^\//, '');
}

/** `--name value` and `--flag` from argv, nothing more elaborate. */
export function args(): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed.set(arg.slice(2), next);
      i++;
    } else {
      parsed.set(arg.slice(2), true);
    }
  }
  return parsed;
}
