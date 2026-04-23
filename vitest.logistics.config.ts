import { mergeConfig } from 'vitest/config';
import { createBaseConfig, logisticsTestIncludes } from './vitest.shared';

/**
 * Logistics Arc-route scenarios — no live carrier HTTP. The suite hits
 * /locations/* (static @classytic/bd-areas dataset) + validation guards
 * on /quote, /shipments, /webhooks/:provider.
 *
 * Runs standalone via `npm run test:logistics`.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'logistics',
    fileParallelism: true,
    sequence: { concurrent: false },
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: logisticsTestIncludes,
  },
});
