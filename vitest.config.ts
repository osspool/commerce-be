import { mergeConfig } from 'vitest/config';
import { createBaseConfig, fastTestIncludes } from './vitest.shared';

export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'fast',
    include: fastTestIncludes,
    testTimeout: 10_000,
    hookTimeout: 15_000,
  },
});
