import { mergeConfig } from 'vitest/config';
import { createBaseConfig, replSetIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'integration-replset',
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 90_000,
    include: replSetIncludes,
  },
});
