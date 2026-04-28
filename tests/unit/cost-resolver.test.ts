/**
 * Unit tests for `lifecycle/handlers/_cost-resolver.ts`.
 *
 * Three observable behaviors:
 *   1. Snapshot cost wins when present and positive.
 *   2. Product cost is the fallback when snapshot has no cost.
 *   3. Lines with neither snapshot nor product cost flag `costMissing: true`
 *      AND still appear in `affectedLines` with source: 'missing' so the
 *      bridge can publish them on the `accounting:cogs.cost_missing` alert.
 */

import { describe, expect, it } from 'vitest';
import { resolveOrderCost } from '#resources/sales/orders/lifecycle/handlers/_cost-resolver.js';

const stubLookupAlways = (cost: number) => async () => cost;
const stubLookupNull = async () => null;

describe('resolveOrderCost', () => {
  it('uses snapshot.costPrice × quantity when snapshot has cost', async () => {
    const order = {
      lines: [
        { lineId: 'l1', quantity: 2, snapshot: { sku: 'A', costPrice: 1500 } },
        { lineId: 'l2', quantity: 1, snapshot: { sku: 'B', costPrice: 800 } },
      ],
    };
    const result = await resolveOrderCost(order, stubLookupNull);
    expect(result.totalCost).toBe(2 * 1500 + 800);
    expect(result.costMissing).toBe(false);
    expect(result.affectedLines.every((l) => l.source === 'snapshot')).toBe(true);
  });

  it('falls back to product cost when snapshot has no cost', async () => {
    const order = {
      lines: [{ lineId: 'l1', quantity: 3, snapshot: { sku: 'C', productId: 'prod-c' } }],
    };
    const result = await resolveOrderCost(order, stubLookupAlways(500));
    expect(result.totalCost).toBe(1500);
    expect(result.costMissing).toBe(false);
    expect(result.affectedLines[0].source).toBe('product');
  });

  it('flags costMissing when neither snapshot nor product yield cost', async () => {
    const order = {
      lines: [{ lineId: 'l1', quantity: 2, snapshot: { sku: 'D', productId: 'prod-d' } }],
    };
    const result = await resolveOrderCost(order, stubLookupNull);
    expect(result.totalCost).toBe(0);
    expect(result.costMissing).toBe(true);
    expect(result.affectedLines[0].source).toBe('missing');
  });

  it('mixes sources cleanly — partial cost data still totals correctly', async () => {
    const order = {
      lines: [
        { lineId: 'l1', quantity: 1, snapshot: { sku: 'A', costPrice: 1000 } },
        { lineId: 'l2', quantity: 2, snapshot: { sku: 'B', productId: 'prod-b' } },
        { lineId: 'l3', quantity: 1, snapshot: { sku: 'C', productId: 'prod-c' } },
      ],
    };
    const lookup = async (productId: string): Promise<number | null> =>
      productId === 'prod-b' ? 250 : null;
    const result = await resolveOrderCost(order, lookup);
    expect(result.totalCost).toBe(1000 + 250 * 2);
    expect(result.costMissing).toBe(true);
    expect(result.affectedLines.map((l) => l.source)).toEqual(['snapshot', 'product', 'missing']);
  });

  it('skips lines with quantity ≤ 0 (cancelled / zeroed lines)', async () => {
    const order = {
      lines: [
        { lineId: 'l1', quantity: 0, snapshot: { sku: 'A', costPrice: 1000 } },
        { lineId: 'l2', quantity: 1, snapshot: { sku: 'B', costPrice: 500 } },
      ],
    };
    const result = await resolveOrderCost(order, stubLookupNull);
    expect(result.totalCost).toBe(500);
    expect(result.affectedLines).toHaveLength(1);
  });

  it('treats lookup throw as null (network blip / catalog miss is not fatal)', async () => {
    const order = {
      lines: [{ lineId: 'l1', quantity: 1, snapshot: { sku: 'A', productId: 'prod-a' } }],
    };
    const lookup = async () => {
      throw new Error('catalog unreachable');
    };
    const result = await resolveOrderCost(order, lookup);
    expect(result.totalCost).toBe(0);
    expect(result.costMissing).toBe(true);
  });
});
