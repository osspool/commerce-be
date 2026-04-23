import { mergeConfig } from 'vitest/config';
import { createBaseConfig, paymentsTestIncludes } from './vitest.shared';

/**
 * Payment webhook scenarios — each owns its own MongoMemoryReplSet via
 * bootScenarioApp (revenue v2 needs transactions).
 *
 * Runs standalone via `npm run test:payments`. Tests here are also picked
 * up by `npm run test:replset` (replSetIncludes).
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'payments',
    fileParallelism: true,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: paymentsTestIncludes,
  },
});
