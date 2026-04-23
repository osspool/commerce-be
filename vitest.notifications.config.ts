import { mergeConfig } from 'vitest/config';
import { createBaseConfig, notificationsTestIncludes } from './vitest.shared';

/**
 * Notification list/mark-read/SSE-guard scenarios.
 *
 * Runs standalone via `npm run test:notifications`.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'notifications',
    fileParallelism: true,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: notificationsTestIncludes,
  },
});
