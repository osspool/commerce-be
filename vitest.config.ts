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
  { name: 'accounting',    hookTimeout: 120_000 },
  { name: 'cart-order',    hookTimeout: 120_000 },
  { name: 'pos',           hookTimeout: 120_000 },
  { name: 'inventory',     hookTimeout: 120_000 },
  { name: 'warehouse',     hookTimeout: 180_000 },
  { name: 'commerce',      hookTimeout: 120_000 },
  { name: 'payments',      hookTimeout: 120_000 },
  { name: 'logistics',     hookTimeout: 120_000 },
  { name: 'notifications', hookTimeout: 120_000 },
  { name: 'analytics',     hookTimeout: 120_000 },
  { name: 'loyalty',       hookTimeout: 120_000 },
  { name: 'branches',      hookTimeout: 180_000 },
] as const;

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    // Global concurrency cap across ALL projects — bounds total concurrent
    // workers so we never spin more in-memory mongod (8.2) replsets than the
    // box (28c/34GB) holds. Without it, unit's thread pool + scenario/integration
    // forks oversubscribe and heavy e2e tests flake under memory/connection load.
    maxWorkers: 10,
    minWorkers: 1,
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
      ...SCENARIO_DOMAINS.map(({ name, hookTimeout }) => ({
        extends: true as const,
        test: {
          name: `scenarios-${name}`,
          pool: 'forks' as const,
          include: [`tests/scenarios/${name}/**/*.test.{js,ts}`],
          isolate: true,
          fileParallelism: true,
          sequence: { concurrent: false },
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
          // Rate-limit tests must not race — serial within this project.
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
