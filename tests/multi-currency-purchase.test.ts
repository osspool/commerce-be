/**
 * Multi-Currency Purchase — Unit Test (fast tier, no DB)
 *
 * Verifies the purchase posting contract correctly splits foreign
 * currency metadata onto journal items when a purchase is in USD/EUR.
 * GL amounts stay in BDT; foreign fields are audit trail only.
 */

import { describe, it, expect } from 'vitest';
import { purchaseToPosting } from '../src/resources/accounting/posting/contracts/purchase.contract.js';

describe('Multi-Currency Purchase Posting', () => {
  const BASE_PURCHASE = {
    purchaseId: 'pur-mc-001',
    supplierId: 'sup-001',
    date: new Date('2026-04-16'),
    inventoryType: 'merchandise',
    isPaid: false,
  };

  it('domestic (BDT) purchase has no foreign currency fields', () => {
    const posting = purchaseToPosting({
      ...BASE_PURCHASE,
      totalAmount: 100_000, // 1000 BDT in paisa
      tax: 15_000,          // 150 BDT VAT
    });

    expect(posting.journalType).toBe('PURCHASES');
    for (const item of posting.items) {
      expect(item.foreignCurrency).toBeUndefined();
      expect(item.exchangeRate).toBeUndefined();
      expect(item.foreignDebit).toBeUndefined();
      expect(item.foreignCredit).toBeUndefined();
    }
    // GL totals in BDT
    const totalDebit = posting.items.reduce((s, i) => s + i.debit, 0);
    const totalCredit = posting.items.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(100_000);
    expect(totalCredit).toBe(100_000);
  });

  it('USD purchase attaches foreign currency metadata to every item', () => {
    const posting = purchaseToPosting({
      ...BASE_PURCHASE,
      totalAmount: 120_500_00, // 120,500 BDT in paisa (1000 USD × 120.50)
      tax: 18_075_00,          // 15% VAT in BDT
      vatRate: 15,
      currency: 'USD',
      exchangeRate: 120.50,
      foreignTotal: 1_000_00,  // 1000 USD in cents
    });

    // GL amounts are always in BDT
    const totalDebit = posting.items.reduce((s, i) => s + i.debit, 0);
    const totalCredit = posting.items.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(120_500_00);
    expect(totalCredit).toBe(120_500_00);

    // Every item has foreign currency metadata
    for (const item of posting.items) {
      expect(item.foreignCurrency).toBe('USD');
      expect(item.exchangeRate).toBe(120.50);
    }

    // Inventory item has foreignDebit (proportional to net)
    const inventoryItem = posting.items.find(i => i.debit > 0 && i.accountCode === '1165');
    expect(inventoryItem).toBeDefined();
    expect(inventoryItem!.foreignDebit).toBeGreaterThan(0);
    expect(inventoryItem!.foreignDebit).toBeLessThan(1_000_00);

    // A/P credit has foreignCredit = full foreign total
    const apItem = posting.items.find(i => i.credit > 0);
    expect(apItem).toBeDefined();
    expect(apItem!.foreignCredit).toBe(1_000_00);
  });

  it('EUR purchase with zero tax still carries foreign metadata', () => {
    const posting = purchaseToPosting({
      ...BASE_PURCHASE,
      totalAmount: 131_200_00, // 131,200 BDT (1000 EUR × 131.20)
      tax: 0,
      currency: 'EUR',
      exchangeRate: 131.20,
      foreignTotal: 1_000_00,
    });

    // No VAT split — only 2 items (inventory + A/P)
    expect(posting.items).toHaveLength(2);

    const inventoryItem = posting.items[0];
    expect(inventoryItem.foreignCurrency).toBe('EUR');
    expect(inventoryItem.exchangeRate).toBe(131.20);
    expect(inventoryItem.debit).toBe(131_200_00); // full amount to inventory (no VAT)

    const apItem = posting.items[1];
    expect(apItem.foreignCredit).toBe(1_000_00);
  });

  it('BDT purchase with currency explicitly set still treated as domestic', () => {
    const posting = purchaseToPosting({
      ...BASE_PURCHASE,
      totalAmount: 50_000,
      tax: 7_500,
      currency: 'BDT',
      exchangeRate: 1,
    });

    // BDT → BDT is domestic, no foreign metadata
    for (const item of posting.items) {
      expect(item.foreignCurrency).toBeUndefined();
    }
  });

  it('idempotencyKey includes purchaseId', () => {
    const posting = purchaseToPosting({
      ...BASE_PURCHASE,
      totalAmount: 100_000,
      tax: 0,
    });
    expect(posting.idempotencyKey).toBe('purchase-pur-mc-001');
  });
});
