import { mergeConfig } from 'vitest/config';
import { createBaseConfig, analyticsTestIncludes } from './vitest.shared';

/**
 * Analytics dashboard scenarios — exercises the /analytics/dashboard
 * aggregation against seeded orders, transactions, and customers.
 *
 * Runs standalone via `npm run test:analytics`.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'analytics',
    fileParallelism: true,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: analyticsTestIncludes,
  },
});
