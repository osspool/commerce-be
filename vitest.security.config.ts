import { mergeConfig } from 'vitest/config';
import { createBaseConfig, securityTestIncludes } from './vitest.shared';

/**
 * Security posture suite — rate-limit enforcement and cross-branch
 * x-organization-id isolation. Uses env overrides at scenario boot to
 * drop RATE_LIMIT_MAX low enough to test quickly.
 *
 * Runs standalone via `npm run test:security`.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'security',
    fileParallelism: false,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 180_000,
    include: securityTestIncludes,
  },
});
