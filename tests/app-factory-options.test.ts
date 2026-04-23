import { describe, expect, it, vi } from 'vitest';
import type { ResourceLike } from '@classytic/arc/factory';

vi.mock('#resources/auth/auth.config.js', () => ({
  getAuth: () => ({ handler: vi.fn(), api: {} }),
}));

const { createArcAppOptions } = await import('../src/core/app/create-arc-app-options.js');

describe('createArcAppOptions', () => {
  it('uses Arc resourceDir discovery for normal app boot', () => {
    const options = createArcAppOptions();

    expect(options.resourcePrefix).toBe('/api/v1');
    expect(options.resourceDir).toBe('src/resources');
    expect(options.resources).toBeUndefined();
    expect(options.plugins).toBeTypeOf('function');
    expect(options.bootstrap).toHaveLength(1);
    expect(options.afterResources).toBeTypeOf('function');
  });

  it('prefers explicit preloaded resources when provided', () => {
    const resources = [{ name: 'test', toPlugin: () => (() => {}) as never }] as ResourceLike[];

    const options = createArcAppOptions({ resources });

    expect(options.resources).toBe(resources);
    expect(options.resourceDir).toBeUndefined();
  });
});
