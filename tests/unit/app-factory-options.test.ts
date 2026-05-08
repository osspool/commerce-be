import { describe, expect, it, vi } from 'vitest';
import type { ResourceLike } from '@classytic/arc/factory';

// `createArcAppOptions` only assembles options — it doesn't touch Mongo —
// but its module graph cascades into mongoose-bearing modules
// (`registerInfraPlugins`, `ensureCatalogEngine`, etc.). Without these
// mocks, model schemas register `softDeletePlugin` TTL indexes at
// import-time and Mongoose buffers `createIndex()` calls against the
// (nonexistent) connection until they time out.
vi.mock('#resources/auth/auth.config.js', () => ({
  getAuth: () => ({ handler: vi.fn(), api: {} }),
}));
vi.mock('#core/app/register-infra-plugins.js', () => ({
  registerInfraPlugins: vi.fn(),
}));
vi.mock('#core/app/register-domain-bootstrap.js', () => ({
  registerDomainBootstrap: vi.fn(),
}));
vi.mock('#core/app/register-after-resources.js', () => ({
  registerAfterResources: vi.fn(),
}));
vi.mock('#resources/catalog/catalog.engine.js', () => ({
  ensureCatalogEngine: vi.fn(),
}));

const { createArcAppOptions } = await import('../../src/core/app/create-arc-app-options.js');

describe('createArcAppOptions', () => {
  it('uses Arc 2.11 async resources factory for normal app boot', () => {
    const options = createArcAppOptions();

    expect(options.resourcePrefix).toBe('/api/v1');
    // Arc 2.11 replaced `resourceDir` with a `resources` async factory so
    // catalog engine + resource construction happen AFTER bootstrap runs.
    // `resourceDir` is no longer set — the factory itself calls
    // `loadResources(RESOURCE_DIR_URL, ...)` internally.
    expect(options.resources).toBeTypeOf('function');
    expect(options.plugins).toBeTypeOf('function');
    expect(options.bootstrap).toHaveLength(1);
    expect(options.afterResources).toBeTypeOf('function');
  });

  it('prefers explicit preloaded resources when provided', () => {
    const resources = [{ name: 'test', toPlugin: () => (() => {}) as never }] as ResourceLike[];

    const options = createArcAppOptions({ resources });

    expect(options.resources).toBe(resources);
  });
});
