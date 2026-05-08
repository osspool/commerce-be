/**
 * Unit tests for individual posting handlers.
 *
 * These exercise the `build()` function directly — pure input → output,
 * no event bus, no `createPosting`. Handlers that hit the DB (orderPaid,
 * orderFulfilled, purchaseReceived, transactionRefunded) are covered
 * end-to-end in scenario tests; this file pins the logic of handlers
 * that are pure transformations of payload data.
 */

import { describe, expect, it, vi } from 'vitest';

// Stub the OrderRef service so cod-settled / cod-cancelled handlers don't
// boot a real Order engine + hit Mongo from a unit test. Handlers care
// about the `customerId` for the A/R partnerId fallback — we return an
// empty result so the handler exercises the orderId-fallback branch
// (matches the "guest checkout" path in [cod-placement.contract.ts]).
vi.mock('../../src/resources/accounting/_shared/order-ref.service.js', () => ({
  getOrderRefAndCustomer: vi.fn(async () => ({})),
  getOrderReferenceNumber: vi.fn(async () => undefined),
}));

import { codCancelledHandler } from '../../src/resources/accounting/events/handlers/cod-cancelled.handler.js';
import { codSettledHandler } from '../../src/resources/accounting/events/handlers/cod-settled.handler.js';
import { inventoryAdjustedHandler } from '../../src/resources/accounting/events/handlers/inventory-adjusted.handler.js';
import { returnRestockedHandler } from '../../src/resources/accounting/events/handlers/return-restocked.handler.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof inventoryAdjustedHandler.build>[1];

describe('inventoryAdjustedHandler.build', () => {
  it('returns posting work for a valid loss adjustment', async () => {
    const work = await inventoryAdjustedHandler.build(
      {
        adjustmentId: 'adj-1',
        type: 'loss',
        amount: 250,
        branchId: 'branch-7',
        date: new Date('2026-04-28'),
        reason: 'damaged',
      },
      log,
    );

    expect(work).not.toBeNull();
    expect(work?.branchId).toBe('branch-7');
    expect(work?.posting).toBeDefined();
    expect(work?.logFields).toEqual({ adjustmentId: 'adj-1', type: 'loss' });
    expect(work?.successMessage).toContain('Inventory adjustment');
  });

  it('returns null for zero amount', async () => {
    const work = await inventoryAdjustedHandler.build(
      { adjustmentId: 'adj-1', type: 'gain', amount: 0, branchId: 'b' },
      log,
    );
    expect(work).toBeNull();
  });

  it('returns null and warns when branchId is missing', async () => {
    vi.mocked(log.warn).mockClear();
    const work = await inventoryAdjustedHandler.build(
      { adjustmentId: 'adj-1', type: 'gain', amount: 50 },
      log,
    );
    expect(work).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      { adjustmentId: 'adj-1' },
      expect.stringContaining('skipping accounting'),
    );
  });
});

describe('returnRestockedHandler.build', () => {
  it('returns posting work for a positive cost restock', async () => {
    const work = await returnRestockedHandler.build(
      {
        returnId: 'rtn-1',
        orderId: 'ord-1',
        costAmount: 1200,
        branchId: 'b',
      },
      log,
    );
    expect(work).not.toBeNull();
    expect(work?.branchId).toBe('b');
    expect(work?.logFields).toMatchObject({
      returnId: 'rtn-1',
      orderId: 'ord-1',
      costAmount: 1200,
    });
  });

  it('still posts at zero cost so the audit trail records the restock', async () => {
    // The handler intentionally posts even when cost is zero — service-fee
    // and promo lines have no COGS, but the restock event itself must be
    // visible in the journal (Dr Inventory 0 / Cr COGS 0). The bridge stamps
    // `costMissing: true` + `affectedLines` so the admin "missing cost" view
    // surfaces the row instead of silently dropping it.
    const work = await returnRestockedHandler.build(
      { returnId: 'rtn-1', orderId: 'ord-1', costAmount: 0, branchId: 'b' },
      log,
    );
    expect(work).not.toBeNull();
    expect(work?.posting?.items?.[0]?.debit).toBe(0);
    expect(work?.posting?.items?.[1]?.credit).toBe(0);
    expect(work?.logFields?.costAmount).toBe(0);
  });

  it('returns null when branchId is missing', async () => {
    const work = await returnRestockedHandler.build(
      { returnId: 'rtn-1', orderId: 'ord-1', costAmount: 100, branchId: '' },
      log,
    );
    expect(work).toBeNull();
  });
});

describe('codSettledHandler.build', () => {
  it('returns posting work with all five amount fields in logs', async () => {
    const work = await codSettledHandler.build(
      {
        settlementId: 'set-1',
        orderId: 'ord-1',
        grossAmount: 1000,
        actualReceived: 920,
        courierCommission: 60,
        writeoff: 20,
        branchId: 'b',
      },
      log,
    );
    expect(work).not.toBeNull();
    expect(work?.logFields).toEqual({
      orderId: 'ord-1',
      settlementId: 'set-1',
      actualReceived: 920,
      courierCommission: 60,
      writeoff: 20,
    });
  });
});

describe('codCancelledHandler.build', () => {
  it('returns posting work for a positive amount cancellation', async () => {
    const work = await codCancelledHandler.build(
      {
        orderId: 'ord-1',
        grossAmount: 500,
        tax: 75,
        promoDiscount: 50,
        branchId: 'b',
        reason: 'customer-cancelled',
      },
      log,
    );
    expect(work).not.toBeNull();
    expect(work?.logFields).toEqual({ orderId: 'ord-1', reason: 'customer-cancelled' });
  });

  it('returns null when grossAmount <= 0', async () => {
    const work = await codCancelledHandler.build(
      { orderId: 'ord-1', grossAmount: 0, tax: 0, branchId: 'b' },
      log,
    );
    expect(work).toBeNull();
  });

  it('returns null when branchId is missing', async () => {
    const work = await codCancelledHandler.build(
      { orderId: 'ord-1', grossAmount: 100, tax: 15, branchId: '' },
      log,
    );
    expect(work).toBeNull();
  });
});
