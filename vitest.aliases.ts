import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
