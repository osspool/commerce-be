/**
 * Read-projection framework unit tests.
 *
 * subscribe() + wrapWithBoundary are mocked so we can invoke the registered
 * subscriber directly and assert the filter → recompute dispatch + reconcile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribed = new Map<string, (evt: unknown) => Promise<void>>();
vi.mock('#lib/events/arcEvents.js', () => ({
  subscribe: (event: string, handler: (evt: unknown) => Promise<void>) => {
    subscribed.set(event, handler);
    return () => {};
  },
}));
vi.mock('@classytic/arc/events', () => ({
  // passthrough so the test can invoke the inner handler directly
  wrapWithBoundary: (fn: (evt: unknown) => Promise<void>) => fn,
}));

import {
  __resetProjections,
  defineProjection,
  listProjections,
  reconcileProjection,
  registerProjections,
} from '../../src/shared/projections.js';

beforeEach(() => {
  __resetProjections();
  subscribed.clear();
});

describe('projection framework', () => {
  it('subscribes its events, filters via selectKey, and recomputes the key', async () => {
    const calls: Array<{ key: string; triggeredBy?: string; event: string }> = [];
    defineProjection({
      name: 'test',
      events: ['x:happened', 'x:changed'],
      selectKey: (p) => (typeof p.skuRef === 'string' ? p.skuRef : null),
      recompute: async (key, ctx) => {
        calls.push({ key, triggeredBy: ctx.triggeredBy, event: ctx.event });
      },
    });
    registerProjections({} as never);

    expect([...subscribed.keys()]).toEqual(['x:happened', 'x:changed']);
    const handler = subscribed.get('x:happened')!;

    // missing key → filtered out, no recompute
    await handler({ payload: { organizationId: 'o1' } });
    expect(calls).toEqual([]);

    // valid → recompute with key + triggeredBy (from organizationId) + event
    await handler({ payload: { skuRef: 'SKU1', organizationId: 'o1' } });
    expect(calls).toEqual([{ key: 'SKU1', triggeredBy: 'o1', event: 'x:happened' }]);

    // legacy envelope shape (payload at root) is handled
    calls.length = 0;
    await handler({ skuRef: 'SKU2', organizationId: 'o2' });
    expect(calls).toEqual([{ key: 'SKU2', triggeredBy: 'o2', event: 'x:happened' }]);
  });

  it('reconcileProjection runs the rebuild, or throws when absent/unknown', async () => {
    defineProjection({
      name: 'withReconcile',
      events: [],
      selectKey: () => null,
      recompute: async () => {},
      reconcile: async () => ({ scanned: 5, rebuilt: 4 }),
    });
    defineProjection({ name: 'noReconcile', events: [], selectKey: () => null, recompute: async () => {} });

    expect(await reconcileProjection('withReconcile')).toEqual({ scanned: 5, rebuilt: 4 });
    await expect(reconcileProjection('noReconcile')).rejects.toThrow(/no reconcile/);
    await expect(reconcileProjection('ghost')).rejects.toThrow(/Unknown projection/);
  });

  it('listProjections returns all registered definitions', () => {
    defineProjection({ name: 'a', events: [], selectKey: () => null, recompute: async () => {} });
    defineProjection({ name: 'b', events: [], selectKey: () => null, recompute: async () => {} });
    expect(listProjections().map((p) => p.name).sort()).toEqual(['a', 'b']);
  });
});
