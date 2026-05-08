/**
 * Unit tests for vendor-bill reversal + supplier-return posting contracts.
 *
 * Pure input → output. Pins the JE shape (account codes, debit/credit sides,
 * idempotency key format, sourceRef) so an accidental swap at any layer
 * (kernel events, host bridge, or ledger) fails here first instead of in
 * production. Mirrors `transfer-contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  supplierReturnToPosting,
  vendorBillReversalToPosting,
  vendorBillToPosting,
} from '../../src/resources/accounting/posting/contracts/vendor-bill.contract.js';

describe('vendorBillReversalToPosting', () => {
  const baseInput = {
    purchaseId: 'po-1',
    supplierId: 'supplier-7',
    totalAmount: 115_000, // paisa = ৳1150 inclusive of tax
    tax: 15_000, // ৳150 input VAT
    vatRate: 15,
    receivedAt: new Date('2026-04-15T10:00:00Z'),
  } as const;

  const reversalInput = {
    purchaseId: 'po-1',
    supplierId: 'supplier-7',
    totalAmount: 115_000,
    tax: 15_000,
    vatRate: 15,
    date: new Date('2026-04-29T10:00:00Z'),
  } as const;

  it('produces a balanced JE that mirrors the original vendor bill totals', () => {
    const original = vendorBillToPosting(baseInput);
    const reversal = vendorBillReversalToPosting(reversalInput);

    const originalDebit = original.items.reduce((s, i) => s + i.debit, 0);
    const originalCredit = original.items.reduce((s, i) => s + i.credit, 0);
    const reversalDebit = reversal.items.reduce((s, i) => s + i.debit, 0);
    const reversalCredit = reversal.items.reduce((s, i) => s + i.credit, 0);

    expect(originalDebit).toBe(originalCredit);
    expect(reversalDebit).toBe(reversalCredit);
    expect(reversalDebit).toBe(originalDebit);
  });

  it('flips A/P from credit to debit, with the supplier partner stamp preserved', () => {
    const out = vendorBillReversalToPosting(reversalInput);
    const apLine = out.items.find((i) => i.accountCode === '2111');
    expect(apLine).toBeDefined();
    expect(apLine?.debit).toBe(115_000);
    expect(apLine?.credit).toBe(0);
    expect(apLine?.partnerId).toBe('supplier-7');
    expect(apLine?.partnerType).toBe('supplier');
  });

  it('flips inventory from debit to credit', () => {
    const out = vendorBillReversalToPosting(reversalInput);
    // Default merchandise account is 1164 (canonical BD chart).
    const invLine = out.items.find((i) => i.accountCode === '1164');
    expect(invLine).toBeDefined();
    expect(invLine?.credit).toBe(100_000); // net of 15k VAT
    expect(invLine?.debit).toBe(0);
  });

  it('flips claimable input VAT from debit to credit when present', () => {
    const out = vendorBillReversalToPosting(reversalInput);
    // Standard 15% rate maps to a non-null input-VAT account; original
    // posted it as debit, reversal posts it as credit.
    const vatLine = out.items.find((i) => i.credit > 0 && i.accountCode !== '1164' && i.accountCode !== '2111');
    expect(vatLine).toBeDefined();
    expect(vatLine?.credit).toBe(15_000);
  });

  it('uses vendor-bill-{purchaseId}-reverse as the idempotency key', () => {
    const out = vendorBillReversalToPosting(reversalInput);
    expect(out.idempotencyKey).toBe('vendor-bill-po-1-reverse');
  });

  it('stamps PurchaseOrder sourceRef so the audit lookup pairs the entries', () => {
    const original = vendorBillToPosting(baseInput);
    const reversal = vendorBillReversalToPosting(reversalInput);
    expect(reversal.sourceRef).toEqual(original.sourceRef);
    expect(reversal.sourceRef?.sourceModel).toBe('PurchaseOrder');
    expect(reversal.sourceRef?.sourceId).toBe('po-1');
  });

  it('appends a reason to the label and A/P line when provided', () => {
    const out = vendorBillReversalToPosting({ ...reversalInput, reason: 'PO cancelled' });
    expect(out.label).toContain('PO cancelled');
    const apLine = out.items.find((i) => i.accountCode === '2111');
    expect(apLine?.label).toContain('PO cancelled');
  });

  it('zero-tax reversal collapses to a clean two-line JE', () => {
    const out = vendorBillReversalToPosting({
      ...reversalInput,
      tax: 0,
      vatRate: 0,
    });
    expect(out.items).toHaveLength(2);
    const ap = out.items.find((i) => i.accountCode === '2111');
    const inv = out.items.find((i) => i.accountCode === '1164');
    expect(ap?.debit).toBe(115_000);
    expect(inv?.credit).toBe(115_000);
  });
});

describe('supplierReturnToPosting', () => {
  const baseInput = {
    purchaseId: 'po-2',
    supplierId: 'supplier-3',
    moveGroupId: 'mg-99',
    lines: [
      { skuRef: 'SKU-A', quantityReturned: 10, unitCost: 50 }, // ৳500
      { skuRef: 'SKU-B', quantityReturned: 5, unitCost: 100 }, // ৳500
    ],
    date: new Date('2026-04-29T10:00:00Z'),
  };

  it('builds a balanced two-line JE — Dr A/P, Cr Inventory', () => {
    const out = supplierReturnToPosting(baseInput);
    expect(out.items).toHaveLength(2);
    const totalDebit = out.items.reduce((s, i) => s + i.debit, 0);
    const totalCredit = out.items.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(100_000); // 1000 BDT × 100 paisa
  });

  it('debits A/P (2111) with the supplier partner stamp', () => {
    const out = supplierReturnToPosting(baseInput);
    const ap = out.items.find((i) => i.accountCode === '2111');
    expect(ap?.debit).toBe(100_000);
    expect(ap?.partnerId).toBe('supplier-3');
    expect(ap?.partnerType).toBe('supplier');
  });

  it('credits inventory (1164 by default)', () => {
    const out = supplierReturnToPosting(baseInput);
    const inv = out.items.find((i) => i.accountCode === '1164');
    expect(inv?.credit).toBe(100_000);
  });

  it('keys idempotency on (purchaseId, moveGroupId) so retries are no-ops', () => {
    const out = supplierReturnToPosting(baseInput);
    expect(out.idempotencyKey).toBe('supplier-return-po-2-mg-99');
  });

  it('two returns against the same PO get distinct idempotency keys', () => {
    const a = supplierReturnToPosting({ ...baseInput, moveGroupId: 'mg-1' });
    const b = supplierReturnToPosting({ ...baseInput, moveGroupId: 'mg-2' });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('treats lines with missing unitCost as zero (host should backfill)', () => {
    const out = supplierReturnToPosting({
      ...baseInput,
      lines: [
        { skuRef: 'SKU-A', quantityReturned: 10 }, // no unitCost
        { skuRef: 'SKU-B', quantityReturned: 5, unitCost: 100 }, // ৳500
      ],
    });
    const ap = out.items.find((i) => i.accountCode === '2111');
    expect(ap?.debit).toBe(50_000); // only line B contributes
  });

  it('stamps PurchaseOrder sourceRef matching the original receipt', () => {
    const out = supplierReturnToPosting(baseInput);
    expect(out.sourceRef?.sourceModel).toBe('PurchaseOrder');
    expect(out.sourceRef?.sourceId).toBe('po-2');
  });

  it('rounds per-line paisa cleanly across the items', () => {
    const out = supplierReturnToPosting({
      ...baseInput,
      lines: [{ skuRef: 'SKU-X', quantityReturned: 3, unitCost: 33.33 }],
    });
    const ap = out.items.find((i) => i.accountCode === '2111');
    // 3 × 33.33 × 100 = 9999 paisa (Math.round on the per-line product).
    expect(ap?.debit).toBe(9999);
  });

  it('appends reason to the label when provided', () => {
    const out = supplierReturnToPosting({ ...baseInput, reason: 'damaged in transit' });
    expect(out.label).toContain('damaged in transit');
  });

  it('zero-quantity lines contribute nothing', () => {
    const out = supplierReturnToPosting({
      ...baseInput,
      lines: [
        { skuRef: 'SKU-A', quantityReturned: 0, unitCost: 50 },
        { skuRef: 'SKU-B', quantityReturned: 5, unitCost: 100 },
      ],
    });
    const ap = out.items.find((i) => i.accountCode === '2111');
    expect(ap?.debit).toBe(50_000);
  });
});
