import { mergeConfig } from 'vitest/config';
import { createBaseConfig, replSetIncludes } from './vitest.shared';

/**
 * Replica-set tests need MongoMemoryReplSet (not MongoMemoryServer).
 * Each test file handles its own replset setup in beforeAll — no global setup.
 *
 * Runs serially (fileParallelism: false). Parallel forks fail on CommonJS
 * module resolution for mongoose — the forks pool mis-handles mongoose's
 * `require('./lib/')` trailing-slash directory import. Serial execution is
 * slower but reliable.
 */
export default mergeConfig(createBaseConfig(), {
  test: {
    name: 'integration-replset',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 90_000,
    include: replSetIncludes,
  },
});
