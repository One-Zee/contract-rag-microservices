import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The `@app/*` aliases for Vitest, derived from the root `tsconfig.json`.
 *
 * Neither `vite-tsconfig-paths` nor the native `resolve.tsconfigPaths` works
 * here: both tie resolution to the project that "owns" a file, and every
 * `tsconfig.app.json` / `tsconfig.lib.json` excludes `**\/*spec.ts` so tests do
 * not land in `dist/`. Spec files are therefore left without a project and
 * `@app/common` fails with "Cannot find package".
 *
 * Reading from the tsconfig instead of listing the aliases by hand means they
 * cannot drift from what `tsc` sees.
 */
const root = dirname(fileURLToPath(import.meta.url));

interface TsConfig {
  compilerOptions?: { paths?: Record<string, string[]> };
}

const { compilerOptions } = JSON.parse(
  readFileSync(resolve(root, 'tsconfig.json'), 'utf8'),
) as TsConfig;

export const appAliases = Object.entries(compilerOptions?.paths ?? {}).map(
  ([pattern, [target]]) => ({
    // "@app/common/*" → /^@app\/common\/(.*)$/, "@app/common" → /^@app\/common$/
    find: new RegExp(
      `^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '(.*)')}$`,
    ),
    replacement: resolve(root, target.replace(/^\.\//, '')).replace(
      /\*/g,
      '$1',
    ),
  }),
);
