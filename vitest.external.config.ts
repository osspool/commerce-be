import { mergeConfig } from 'vitest/config';
import { createBaseConfig, externalTestIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'external',
    globalSetup: './tests/setup/global-setup.js',
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: externalTestIncludes,
  },
});
