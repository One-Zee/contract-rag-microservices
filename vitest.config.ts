import { defineConfig } from 'vitest/config';
import { appAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: { alias: appAliases },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Without this, `**/*.spec.ts` would also pick up the e2e tests, which need
    // a running Postgres and have their own config.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-spec.ts'],
  },
});
