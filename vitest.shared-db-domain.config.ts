import { mergeConfig } from 'vitest/config';
import { createBaseConfig, sharedDbDomainIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'shared-db-domain',
    globalSetup: './tests/setup/global-setup.js',
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: sharedDbDomainIncludes,
  },
});
