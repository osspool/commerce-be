import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { configureArcLogger } from '@classytic/arc/logger';
import { validateEnvironment } from '../src/config/validator.js';

interface Call {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function createStubWriter(): { calls: Call[]; writer: Record<Call['level'], (...args: unknown[]) => void> } {
  const calls: Call[] = [];
  return {
    calls,
    writer: {
      debug: (...args) => calls.push({ level: 'debug', args }),
      info: (...args) => calls.push({ level: 'info', args }),
      warn: (...args) => calls.push({ level: 'warn', args }),
      error: (...args) => calls.push({ level: 'error', args }),
    },
  };
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const TOUCHED_KEYS = [
  'NODE_ENV', 'ENV', 'JWT_SECRET', 'MONGO_URI', 'APP_URL', 'FRONTEND_URL', 'PORT',
  'RATE_LIMIT_MAX', 'CORS_ORIGIN', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET',
  'ARC_DEBUG',
];

describe('validateEnvironment logging', () => {
  let stub: ReturnType<typeof createStubWriter>;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv(TOUCHED_KEYS);
    stub = createStubWriter();
    // ARC_DEBUG enables info so we can observe the success path.
    process.env.ARC_DEBUG = '*';
    configureArcLogger({ writer: stub.writer, debug: true });
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    configureArcLogger({});
  });

  it('routes errors through the arcLog writer (not raw console)', () => {
    delete process.env.JWT_SECRET;
    delete process.env.MONGO_URI;
    process.env.NODE_ENV = 'test';

    validateEnvironment();

    const errors = stub.calls.filter((c) => c.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.map((c) => c.args.join(' ')).join('\n');
    expect(joined).toContain('Environment validation');
    expect(joined).toContain('JWT_SECRET');
    expect(joined).toContain('MONGO_URI');
  });

  it('never emits emoji characters in log output', () => {
    delete process.env.JWT_SECRET;
    delete process.env.MONGO_URI;
    process.env.NODE_ENV = 'test';

    validateEnvironment();

    const allText = stub.calls.flatMap((c) => c.args).join(' ');
    // Reject any char in the emoji/pictograph ranges — covers ✅❌⚠️ and friends.
    expect(allText).not.toMatch(/[\u2600-\u27BF]|[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\uFE0F]/);
  });

  it('emits a success log when no errors and no warnings', () => {
    process.env.JWT_SECRET = 'a-very-long-secret-at-least-32-chars-yes';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    process.env.APP_URL = 'http://localhost:3000';
    process.env.FRONTEND_URL = 'http://localhost:3001';
    process.env.PORT = '3000';
    process.env.NODE_ENV = 'test';

    const result = validateEnvironment();

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    const infos = stub.calls.filter((c) => c.level === 'info');
    const infoText = infos.map((c) => c.args.join(' ')).join(' ');
    expect(infoText.toLowerCase()).toContain('validation');
  });

  it('silent=true suppresses all writer output', () => {
    delete process.env.JWT_SECRET;
    delete process.env.MONGO_URI;

    validateEnvironment({ silent: true });

    expect(stub.calls).toHaveLength(0);
  });
});
