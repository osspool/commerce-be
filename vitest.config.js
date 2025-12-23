import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: './tests/setup/global-setup.js',
    // Integration tests share a single MongoDB instance and perform aggressive cleanup.
    // Running test files in parallel can delete data used by other suites (flaky 404/DocumentNotFoundError).
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'tests/**',
        '**/*.config.js',
      ],
    },
    include: ['tests/**/*.test.js', 'modules/**/tests/**/*.test.js'],
    exclude: ['node_modules/**', 'test/**'],
  },
  resolve: {
    alias: {
      '#common': path.resolve(__dirname, './common'),
      '#config': path.resolve(__dirname, './config'),
      '#models': path.resolve(__dirname, './models'),
      '#modules': path.resolve(__dirname, './modules'),
      '#routes': path.resolve(__dirname, './routes'),
      '#utils': path.resolve(__dirname, './utils'),
      '#lib': path.resolve(__dirname, './lib'),
    },
  },
});
