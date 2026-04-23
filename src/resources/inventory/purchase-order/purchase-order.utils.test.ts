/**
 * purchase.utils paisa-math contract tests.
 *
 * These pin the float-drift fixes from the inventory refactor (2026-04-23).
 * Naive `+` / `*` on BDT amounts accumulates IEEE 754 error per line; the
 * helpers here aggregate in paisa-integer arithmetic so totals are exact
 * for any input order or line count.
 *
 * Watch points:
 *   - `999.99 + 0.01` MUST land on exactly `1000` so `paymentStatus` flips
 *     from `partial` → `paid` on the final installment.
 *   - Multi-line discount + tax aggregation MUST be deterministic regardless
 *     of input order (no float-add-order sensitivity).
 *   - Proportional tax allocation MUST round to nearest paisa, not silently
 *     drop a fractional sub-paisa.
 */

import { describe, expect, it } from 'vitest';
import {
  addBdt,
  applyRatioBdt,
  computeLineTotals,
  computePaymentStatus,
  computePurchaseTotals,
} from './purchase-order.utils.js';

describe('purchase.utils — paisa arithmetic', () => {
  describe('addBdt', () => {
    it('999.99 + 0.01 === 1000 (no float drift)', () => {
      expect(addBdt(999.99, 0.01)).toBe(1000);
    });

    it('0.1 + 0.2 === 0.3 (the canonical IEEE 754 trap)', () => {
      expect(addBdt(0.1, 0.2)).toBe(0.3);
    });

    it('treats undefined / null / NaN as 0 (defensive boundary)', () => {
      expect(addBdt(undefined, 1.5)).toBe(1.5);
      expect(addBdt(1.5, null)).toBe(1.5);
      expect(addBdt(NaN, 1.5)).toBe(1.5);
    });
  });

  describe('applyRatioBdt', () => {
    it('rounds proportional tax to the nearest paisa', () => {
      // 100 BDT @ 1/3 ratio -> 33.33333... -> rounds to 33.33 BDT.
      expect(applyRatioBdt(100, 1 / 3)).toBe(33.33);
    });

    it('preserves zero amounts cleanly', () => {
      expect(applyRatioBdt(0, 0.5)).toBe(0);
      expect(applyRatioBdt(100, 0)).toBe(0);
    });
  });

  describe('computeLineTotals', () => {
    it('quantity * costPrice computed in paisa (no 0.30000000000000004)', () => {
      const result = computeLineTotals({ quantity: 3, costPrice: 0.1 });
      expect(result.lineTotal).toBe(0.3);
      expect(result.taxableAmount).toBe(0.3);
    });

    it('clamps discount to lineTotal so taxable never goes negative', () => {
      const result = computeLineTotals({ quantity: 1, costPrice: 100, discount: 500 });
      expect(result.discount).toBe(100);
      expect(result.taxableAmount).toBe(0);
      expect(result.taxAmount).toBe(0);
    });

    it('15% VAT on a tricky base rounds to nearest paisa', () => {
      // 1000.01 * 0.15 = 150.0015 — should land on 150.00, not 150.001.
      const result = computeLineTotals({ quantity: 1, costPrice: 1000.01, taxRate: 15 });
      expect(result.taxAmount).toBe(150);
    });

    it('clamps taxRate to [0, 100]', () => {
      const high = computeLineTotals({ quantity: 1, costPrice: 100, taxRate: 999 });
      expect(high.taxRate).toBe(100);
      const low = computeLineTotals({ quantity: 1, costPrice: 100, taxRate: -5 });
      expect(low.taxRate).toBe(0);
    });
  });

  describe('computePurchaseTotals', () => {
    it('aggregates 1000 lines of 0.01 BDT into exactly 10.00 (no drift)', () => {
      const items = Array.from({ length: 1000 }, () => ({ quantity: 1, costPrice: 0.01 }));
      const totals = computePurchaseTotals(items);
      expect(totals.subTotal).toBe(10);
      expect(totals.grandTotal).toBe(10);
    });

    it('order-independent: totals match for shuffled vs sorted input', () => {
      const lines = [
        { quantity: 1, costPrice: 0.1 },
        { quantity: 1, costPrice: 0.2 },
        { quantity: 1, costPrice: 0.3 },
        { quantity: 7, costPrice: 19.99 },
      ];
      const a = computePurchaseTotals(lines).grandTotal;
      const b = computePurchaseTotals([...lines].reverse()).grandTotal;
      expect(a).toBe(b);
    });

    it('sub - discount + tax adds up exactly', () => {
      const totals = computePurchaseTotals([
        { quantity: 2, costPrice: 100, discount: 5, taxRate: 15 },
        { quantity: 1, costPrice: 50, discount: 0, taxRate: 5 },
      ]);
      // line 1: 200 - 5 = 195 taxable, tax = 29.25
      // line 2: 50  - 0 = 50  taxable, tax = 2.50
      expect(totals.subTotal).toBe(250);
      expect(totals.discountTotal).toBe(5);
      expect(totals.taxTotal).toBe(31.75);
      expect(totals.grandTotal).toBe(276.75);
    });
  });

  describe('computePaymentStatus', () => {
    it('flips to "paid" exactly when due hits zero (no float residue)', () => {
      // The bug: 999.99 + 0.01 used to be 999.9999999... → still "partial".
      const cumulative = addBdt(999.99, 0.01);
      const status = computePaymentStatus(1000, cumulative);
      expect(status.paymentStatus).toBe('paid');
      expect(status.dueAmount).toBe(0);
      expect(status.paidAmount).toBe(1000);
    });

    it('reports "partial" when paid > 0 and dueAmount > 0', () => {
      const status = computePaymentStatus(1000, 250.5);
      expect(status.paymentStatus).toBe('partial');
      expect(status.dueAmount).toBe(749.5);
    });

    it('reports "unpaid" when paid is 0', () => {
      const status = computePaymentStatus(1000, 0);
      expect(status.paymentStatus).toBe('unpaid');
      expect(status.dueAmount).toBe(1000);
    });

    it('clamps negative inputs to zero (defensive)', () => {
      const status = computePaymentStatus(-50, -10);
      expect(status.paymentStatus).toBe('unpaid');
      expect(status.dueAmount).toBe(0);
    });
  });
});
