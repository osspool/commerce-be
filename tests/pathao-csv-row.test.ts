/**
 * orderToPathaoRow — UNIT
 *
 * The Pathao bulk-CSV mapper is pure (no Mongo, no Fastify), so it belongs
 * in the FAST tier. These tests lock the two behaviors that silently
 * regressed in the original implementation:
 *
 *   1. Reads the shipping address from the Fulfillment, NOT `order.deliveryAddress`
 *      (the Order doc has no address fields in the @classytic/order kernel).
 *   2. Reads lines from `order.lines[]` with `snapshot` metadata, NOT the
 *      legacy `order.items[]` shape. Each line's weight comes off
 *      `snapshot.weightGrams` when the catalog bridge populated it.
 *   3. Reads notes from `order.metadata.notes` first (POS writes here),
 *      with fallback to the top-level `notes` field for /place orders.
 *
 * There is no fixture bus here — each scenario constructs the minimum
 * order + fulfillment shape it needs.
 */

import { describe, it, expect } from 'vitest';
import { orderToPathaoRow } from '../src/resources/logistics/logistics.controller.js';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'ord-abc',
    orderNumber: 'ORD-2026-0042',
    totals: { grandTotal: { amount: 250000, currency: 'BDT' } }, // 2500 BDT
    lines: [
      {
        quantity: 2,
        snapshot: { productId: 'p1', name: 'Widget', weightGrams: 400 },
      },
    ],
    ...overrides,
  };
}

function makeFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    orderNumber: 'ORD-2026-0042',
    shippingAddress: {
      name: 'Rahim Uddin',
      phone: '01712345678',
      line1: 'House 5, Road 3',
      line2: 'Dhanmondi',
      city: 'Dhaka',
      state: 'Dhaka',
      country: 'Bangladesh',
    },
    ...overrides,
  };
}

describe('orderToPathaoRow', () => {
  it('reads shipping address from the fulfillment, NOT the order', async () => {
    // Put bogus data on order.deliveryAddress to catch any regression that
    // reads from the order instead of the fulfillment.
    const order = makeOrder({
      deliveryAddress: {
        recipientName: 'WRONG — should not be read',
        addressLine1: 'WRONG — should not be read',
      },
    });
    const fulfillment = makeFulfillment();

    const row = orderToPathaoRow(order, fulfillment);

    expect(row.recipientName).toBe('Rahim Uddin');
    expect(row.recipientPhone).toBe('01712345678'); // digits-only, already was
    expect(row.recipientAddress).toBe('House 5, Road 3, Dhanmondi');
    expect(row.recipientCity).toBe('Dhaka');
  });

  it('falls back to legacy FE-shape field names on a pre-migration fulfillment', async () => {
    // Orders placed BEFORE the toFulfillmentAddress translator landed may
    // have fulfillments with the FE shape already saved (Mongoose strict
    // would have stripped unknowns, but some test fixtures seed raw).
    // The reader accepts both shapes.
    const fulfillment = makeFulfillment({
      shippingAddress: {
        recipientName: 'Legacy Buyer',
        recipientPhone: '01611112222',
        addressLine1: 'Old House 9',
        addressLine2: 'Mirpur',
        city: 'Dhaka',
        country: 'Bangladesh',
      },
    });

    const row = orderToPathaoRow(makeOrder(), fulfillment);

    expect(row.recipientName).toBe('Legacy Buyer');
    expect(row.recipientPhone).toBe('01611112222');
    expect(row.recipientAddress).toBe('Old House 9, Mirpur');
  });

  it('strips non-digits from the phone number', async () => {
    const fulfillment = makeFulfillment({
      shippingAddress: {
        ...makeFulfillment().shippingAddress,
        phone: '+880 1712-345-678',
      },
    });
    expect(orderToPathaoRow(makeOrder(), fulfillment).recipientPhone).toBe('8801712345678');
  });

  it('computes total weight from order.lines[].snapshot.weightGrams × quantity', async () => {
    const order = makeOrder({
      lines: [
        { quantity: 2, snapshot: { weightGrams: 400 } }, // 800g
        { quantity: 3, snapshot: { weightGrams: 300 } }, // 900g
      ],
    });
    // 1700g = 1.7kg (within Pathao 0.5–10 kg range)
    expect(orderToPathaoRow(order, makeFulfillment()).itemWeight).toBe(1.7);
  });

  it('defaults weight to 0.5 kg when no weightGrams are available (Pathao minimum)', async () => {
    const order = makeOrder({
      lines: [{ quantity: 1, snapshot: { productId: 'p1' } }], // no weight
    });
    expect(orderToPathaoRow(order, makeFulfillment()).itemWeight).toBe(0.5);
  });

  it('caps weight at 10 kg (Pathao maximum)', async () => {
    const order = makeOrder({
      lines: [{ quantity: 50, snapshot: { weightGrams: 500 } }], // 25kg raw
    });
    expect(orderToPathaoRow(order, makeFulfillment()).itemWeight).toBe(10);
  });

  it('uses itemQuantity = sum of line quantities (not 1 per line)', async () => {
    const order = makeOrder({
      lines: [
        { quantity: 3, snapshot: {} },
        { quantity: 2, snapshot: {} },
      ],
    });
    expect(orderToPathaoRow(order, makeFulfillment()).itemQuantity).toBe(5);
  });

  it('prefers order.metadata.notes over top-level order.notes (POS convention)', async () => {
    // POS stamps notes into metadata; /place stamps to the top-level field.
    // When both exist, metadata wins (explicit POS path).
    const order = makeOrder({
      metadata: { notes: 'POS note — ring bell twice' },
      notes: 'storefront note (should be ignored)',
    });
    expect(orderToPathaoRow(order, makeFulfillment()).specialInstruction).toBe(
      'POS note — ring bell twice',
    );
  });

  it('falls back to top-level order.notes when metadata has no notes', async () => {
    const order = makeOrder({ notes: 'Leave with security' });
    expect(orderToPathaoRow(order, makeFulfillment()).specialInstruction).toBe(
      'Leave with security',
    );
  });

  it('omits specialInstruction when no notes anywhere', async () => {
    const row = orderToPathaoRow(makeOrder(), makeFulfillment());
    expect(row.specialInstruction).toBeUndefined();
  });

  it('reads COD amount from order.totals.grandTotal.amount (paisa)', async () => {
    // 150 000 paisa = 1500 BDT in the order, Pathao wants raw paisa.
    const order = makeOrder({
      totals: { grandTotal: { amount: 150000, currency: 'BDT' } },
    });
    expect(orderToPathaoRow(order, makeFulfillment()).amountToCollect).toBe(150000);
  });

  it('accepts legacy order.items[] when order.lines[] is absent', async () => {
    // Historical orders haven't been reshaped. The reader walks lines first,
    // falls back to items.
    const order = {
      _id: 'legacy-ord',
      orderNumber: 'OLD-0001',
      totals: { grandTotal: { amount: 80000, currency: 'BDT' } },
      items: [{ quantity: 4, weightGrams: 250 }], // legacy flat shape
    };
    const row = orderToPathaoRow(order as never, makeFulfillment());
    expect(row.itemQuantity).toBe(4);
    expect(row.itemWeight).toBe(1); // 4 × 250g = 1kg
  });

  it('builds a blank-address row when the fulfillment is missing entirely', async () => {
    // Sanity: the function should return a row even when no fulfillment was
    // found. The caller (exportPathaoCsv) keeps the order in the CSV; the
    // Pathao import side will reject it, which is the correct failure signal
    // — "this order isn't ready to ship, fix it".
    const row = orderToPathaoRow(makeOrder(), undefined);
    expect(row.recipientName).toBe('');
    expect(row.recipientPhone).toBe('');
    expect(row.recipientAddress).toBe('');
    // Quantity / weight still computed from the order lines.
    expect(row.itemQuantity).toBe(2);
    expect(row.itemWeight).toBe(0.8); // 2 × 400g = 800g
  });

  it('falls back from addressLine2 hint to zone when no pathaoZoneId is present', async () => {
    // Legacy path: no explicit Pathao zone ID → use line2 as the zone
    // hint (addressLine2 is often "Dhanmondi" / "Gulshan" etc in BD forms).
    const fulfillment = makeFulfillment({
      shippingAddress: {
        name: 'X', line1: 'Y', line2: 'Gulshan', city: 'Dhaka', country: 'BD',
      },
    });
    expect(orderToPathaoRow(makeOrder(), fulfillment).recipientZone).toBe('Gulshan');
  });

  it('truncates merchantOrderId to last 12 chars (Pathao limit)', async () => {
    const order = makeOrder({ orderNumber: 'ORD-2026-LONG-0000000042' });
    expect(orderToPathaoRow(order, makeFulfillment()).merchantOrderId).toBe(
      'ORD-2026-LONG-0000000042'.slice(-12),
    );
  });
});
