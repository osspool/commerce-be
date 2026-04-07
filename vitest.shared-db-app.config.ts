import { mergeConfig } from 'vitest/config';
import { createBaseConfig, sharedDbAppBootIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'shared-db-app',
    globalSetup: './tests/setup/global-setup.js',
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: sharedDbAppBootIncludes,
  },
});
