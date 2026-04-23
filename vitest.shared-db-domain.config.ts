import { mergeConfig } from 'vitest/config';
import { createBaseConfig, sharedDbDomainIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'shared-db-domain',
    setupFiles: ['./tests/setup/per-suite-mongo.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: sharedDbDomainIncludes,
  },
});
