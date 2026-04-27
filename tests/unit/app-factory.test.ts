import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceLike } from '@classytic/arc/factory';

const connectDatabase = vi.fn();
const createApp = vi.fn();
const createArcAppOptions = vi.fn();

vi.mock('../../src/config/env-loader.js', () => ({}));
vi.mock('#resources/accounting/accounting.engine.js', () => ({}));
vi.mock('../../src/config/db.connect.js', () => ({
  connectDatabase,
}));
vi.mock('@classytic/arc/factory', () => ({
  createApp,
}));
vi.mock('#core/app/create-arc-app-options.js', () => ({
  createArcAppOptions,
}));

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('createApplication', () => {
  const OUTER_ENV_KEYS = ['BETTER_AUTH_SECRET', 'MONGO_URI', 'NODE_ENV'];
  let outerSnap: Record<string, string | undefined>;

  beforeEach(() => {
    outerSnap = snapshotEnv(OUTER_ENV_KEYS);
    // Ensure boot-level env validation has what it needs. Individual tests
    // can still delete a key after this to drive a fail-fast scenario.
    process.env.NODE_ENV = 'test';
    process.env.BETTER_AUTH_SECRET = 'a-valid-better-auth-secret-at-least-32-chars';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';

    vi.clearAllMocks();
    createArcAppOptions.mockReturnValue({ resourceDir: 'src/resources' });
    createApp.mockResolvedValue({ ready: vi.fn() });
  });

  afterEach(() => {
    restoreEnv(outerSnap);
  });

  it('connects the database and boots Arc with resourceDir when no resources are provided', async () => {
    const { createApplication } = await import('../../src/app.js');

    await createApplication();

    expect(connectDatabase).toHaveBeenCalledTimes(1);
    expect(createArcAppOptions).toHaveBeenCalledWith({ resources: undefined });
    expect(createApp).toHaveBeenCalledWith({ resourceDir: 'src/resources' });
  });

  it('passes explicit preloaded resources through for tests', async () => {
    const resources = [{ name: 'test', toPlugin: () => (() => {}) as never }] as ResourceLike[];
    const arcOptions = { resources };
    createArcAppOptions.mockReturnValue(arcOptions);

    const { createApplication } = await import('../../src/app.js');
    await createApplication({ resources });

    expect(connectDatabase).toHaveBeenCalledTimes(1);
    expect(createArcAppOptions).toHaveBeenCalledWith({ resources });
    expect(createApp).toHaveBeenCalledWith(arcOptions);
  });

  describe('env validation at boot', () => {
    it('fails fast when BETTER_AUTH_SECRET is missing — DB is never contacted', async () => {
      delete process.env.BETTER_AUTH_SECRET;

      const { createApplication } = await import('../../src/app.js');
      await expect(createApplication()).rejects.toThrow(/BETTER_AUTH_SECRET/);
      expect(connectDatabase).not.toHaveBeenCalled();
    });

    it('fails fast when MONGO_URI is missing — DB is never contacted', async () => {
      delete process.env.MONGO_URI;

      const { createApplication } = await import('../../src/app.js');
      await expect(createApplication()).rejects.toThrow(/MONGO_URI/);
      expect(connectDatabase).not.toHaveBeenCalled();
    });

    it('proceeds to DB connect + Arc boot when env is valid', async () => {
      const { createApplication } = await import('../../src/app.js');
      await createApplication();
      expect(connectDatabase).toHaveBeenCalledTimes(1);
      expect(createApp).toHaveBeenCalledTimes(1);
    });
  });
});
