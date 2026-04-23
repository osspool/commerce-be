import { mergeConfig } from 'vitest/config';
import { createBaseConfig, branchesTestIncludes } from './vitest.shared';

/**
 * Branch lifecycle scenarios — list/lookup, default-pointer management,
 * auto-warehouse bootstrap per branch, isolation between scopes.
 *
 * Runs standalone via `npm run test:branches`.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'branches',
    fileParallelism: true,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 180_000,
    include: branchesTestIncludes,
  },
});
