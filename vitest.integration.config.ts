import { mergeConfig } from 'vitest/config';
import {
  createBaseConfig,
  integrationSharedExcludes,
  integrationSharedIncludes,
} from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'integration-shared-db',
    globalSetup: './tests/setup/global-setup.js',
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: integrationSharedIncludes,
    exclude: [...integrationSharedExcludes, 'node_modules/**', 'test/**'],
  },
});
