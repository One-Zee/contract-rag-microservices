import { defineConfig } from 'vitest/config';
import { appAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: { alias: appAliases },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The e2e tests boot a real TCP microservice against a real database;
    // running them in parallel would mix up their ports and data.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
