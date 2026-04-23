/**
 * inventory.jobs handlers — unit-level contract tests.
 *
 * Pins the auto-procurement behaviour added 2026-04-23: the cron tick
 * MUST call `generateDemand` after `evaluateRules` returns triggers, so
 * replenishment rules actually create PO / transfer docs without a manual
 * HTTP call.
 *
 * Mocks `getFlowEngineOrNull` rather than booting the full Flow engine
 * because:
 *   1. The handler's only dependencies are `evaluateRules` +
 *      `generateDemand` — narrow, mockable contract.
 *   2. The real persistence path is already covered end-to-end by
 *      `inventory-replenishment.scenario.test.ts`. This test pins the
 *      WIRING (does the cron actually delegate?) at unit speed.
 *   3. Cron handlers never had a test before — keeping it lightweight
 *      avoids adding minutes to the suite for a 5-line wiring change.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const evaluateRules = vi.fn();
const generateDemand = vi.fn();

vi.mock('./flow/flow-engine.js', () => ({
  getFlowEngineOrNull: () => ({
    services: {
      replenishment: {
        evaluateRules,
        generateDemand,
      },
    },
  }),
}));

vi.mock('./flow/context-helpers.js', () => ({
  buildFlowContext: (orgId: string, actor?: string) => ({ organizationId: orgId, actorId: actor }),
}));

import { handleStockAlert } from './inventory.jobs.js';

afterEach(() => {
  evaluateRules.mockReset();
  generateDemand.mockReset();
});

describe('handleStockAlert — auto-procurement cron', () => {
  it('skips when no organizationId in job data', async () => {
    const result = await handleStockAlert({ data: {} });
    expect(result).toEqual({ skipped: true });
    expect(evaluateRules).not.toHaveBeenCalled();
    expect(generateDemand).not.toHaveBeenCalled();
  });

  it('returns triggers=0 and does NOT call generateDemand when no rules fire', async () => {
    evaluateRules.mockResolvedValueOnce({ triggers: [] });

    const result = await handleStockAlert({ data: { organizationId: 'org-1' } });

    expect(result).toEqual({ triggers: 0 });
    expect(evaluateRules).toHaveBeenCalledOnce();
    expect(generateDemand).not.toHaveBeenCalled();
  });

  it('auto-fires generateDemand when triggers exist; reports orders + transfers created', async () => {
    evaluateRules.mockResolvedValueOnce({ triggers: [{ skuRef: 'SKU-A' }, { skuRef: 'SKU-B' }] });
    generateDemand.mockResolvedValueOnce({
      purchaseOrders: [{ _id: 'po-1' }],
      transferGroups: [{ _id: 'tg-1' }, { _id: 'tg-2' }],
    });

    const result = await handleStockAlert({ data: { organizationId: 'org-1' } });

    expect(generateDemand).toHaveBeenCalledOnce();
    // The evaluation object MUST be passed through unchanged so generateDemand
    // can fan out per-rule scope correctly.
    expect(generateDemand).toHaveBeenCalledWith(
      { triggers: [{ skuRef: 'SKU-A' }, { skuRef: 'SKU-B' }] },
      { organizationId: 'org-1', actorId: 'system:cron:stock-alert' },
    );
    expect(result).toEqual({ triggers: 2, ordersCreated: 1, transfersCreated: 2 });
  });

  it('respects dryRun=true: evaluates but does NOT create demand', async () => {
    evaluateRules.mockResolvedValueOnce({ triggers: [{ skuRef: 'SKU-A' }] });

    const result = await handleStockAlert({
      data: { organizationId: 'org-1', dryRun: true },
    });

    expect(result).toEqual({ triggers: 1 });
    expect(generateDemand).not.toHaveBeenCalled();
  });

  it('forwards skuRef + nodeId filters into evaluateRules', async () => {
    evaluateRules.mockResolvedValueOnce({ triggers: [] });

    await handleStockAlert({
      data: { organizationId: 'org-1', skuRef: 'SKU-X', nodeId: 'node-7' },
    });

    expect(evaluateRules).toHaveBeenCalledWith(
      { skuRef: 'SKU-X', nodeId: 'node-7' },
      { organizationId: 'org-1', actorId: 'system:cron:stock-alert' },
    );
  });

  it('handles missing purchaseOrders / transferGroups in result (defensive)', async () => {
    evaluateRules.mockResolvedValueOnce({ triggers: [{ skuRef: 'SKU-A' }] });
    // generateDemand may return a partial result if e.g. only manufacture
    // intents fire — neither purchaseOrders nor transferGroups is required.
    generateDemand.mockResolvedValueOnce({});

    const result = await handleStockAlert({ data: { organizationId: 'org-1' } });

    expect(result).toEqual({ triggers: 1, ordersCreated: 0, transfersCreated: 0 });
  });
});
