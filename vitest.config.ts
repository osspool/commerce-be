import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const alias = {
  '#config': path.resolve(__dirname, './src/config'),
  '#core': path.resolve(__dirname, './src/core'),
  '#shared': path.resolve(__dirname, './src/shared'),
  '#resources': path.resolve(__dirname, './src/resources'),
  '#routes': path.resolve(__dirname, './src/routes'),
  '#lib': path.resolve(__dirname, './src/lib'),
};

const SHARED_DB_SETUP = ['./tests/support/per-suite-mongo.ts'];

const SCENARIO_DOMAINS = [
  { name: 'accounting',    maxForks: 2, hookTimeout: 120_000 },
  { name: 'cart-order',    maxForks: 2, hookTimeout: 120_000 },
  { name: 'pos',           maxForks: 2, hookTimeout: 120_000 },
  { name: 'inventory',     maxForks: 2, hookTimeout: 120_000 },
  { name: 'warehouse',     maxForks: 2, hookTimeout: 180_000 },
  { name: 'commerce',      maxForks: 2, hookTimeout: 120_000 },
  { name: 'payments',      maxForks: 2, hookTimeout: 120_000 },
  { name: 'logistics',     maxForks: 2, hookTimeout: 120_000 },
  { name: 'notifications', maxForks: 2, hookTimeout: 120_000 },
  { name: 'analytics',     maxForks: 2, hookTimeout: 120_000 },
  { name: 'loyalty',       maxForks: 2, hookTimeout: 120_000 },
  { name: 'branches',      maxForks: 2, hookTimeout: 180_000 },
] as const;

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['node_modules/**', 'tests/**', '**/*.config.ts', 'dist/**'],
    },
    exclude: ['node_modules/**', 'test/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          pool: 'threads',
          include: [
            'tests/unit/**/*.test.{js,ts}',
            'src/**/*.test.{js,ts}',
          ],
          // Orphans — not in the pre-refactor include lists, import broken
          // subpaths. Fix or delete before re-enabling.
          exclude: [
            'tests/unit/revenue-system.test.js',
            'tests/unit/product-view-tracking.test.js',
            'node_modules/**',
          ],
          testTimeout: 10_000,
          hookTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration-app',
          pool: 'forks',
          include: ['tests/integration/app/**/*.test.{js,ts}'],
          setupFiles: SHARED_DB_SETUP,
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration-domain',
          pool: 'forks',
          include: ['tests/integration/domain/**/*.test.{js,ts}'],
          setupFiles: SHARED_DB_SETUP,
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration-shared',
          pool: 'forks',
          include: ['tests/integration/shared/**/*.test.{js,ts}'],
          setupFiles: SHARED_DB_SETUP,
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      ...SCENARIO_DOMAINS.map(({ name, maxForks, hookTimeout }) => ({
        extends: true as const,
        test: {
          name: `scenarios-${name}`,
          pool: 'forks' as const,
          include: [`tests/scenarios/${name}/**/*.test.{js,ts}`],
          isolate: true,
          fileParallelism: true,
          sequence: { concurrent: false },
          poolOptions: { forks: { maxForks, minForks: 1 } },
          testTimeout: 30_000,
          hookTimeout,
        },
      })),
      {
        // Rate-limit tests must not race each other — kept serial.
        extends: true,
        test: {
          name: 'scenarios-security',
          pool: 'forks',
          include: ['tests/scenarios/security/**/*.test.{js,ts}'],
          isolate: true,
          fileParallelism: false,
          sequence: { concurrent: false },
          poolOptions: { forks: { maxForks: 1, minForks: 1 } },
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
