/**
 * Anti-regression test — pins the LedgerBridge port's shape.
 *
 * The invoice engine consumes `LedgerBridge` as a port. Swapping in QuickBooks,
 * Xero, or a no-op must satisfy the same three-method contract. This test
 * fails loud if anyone tightens the port in a way that breaks that swap story.
 *
 * (The classytic-backed bridge is constructed at runtime against a real
 * accounting engine; its structural assembly is exercised by
 * tests/integration/invoice-engine.test.ts using a mockLedger. This test
 * stays in the fast tier — no DB, no network.)
 */

import { describe, it, expect } from 'vitest';
import type { LedgerBridge } from '@classytic/invoice/domain/contracts';
import { BD_ACCOUNTS } from '#resources/accounting/invoice/bridges/ledger-classytic.bridge.js';

describe('LedgerBridge port', () => {
  it('a minimal stub satisfies the port (swap story — QuickBooks/Xero/no-op parity)', () => {
    const stub: LedgerBridge = {
      async createJournalEntry() {
        return 'je-1';
      },
      async reverseJournalEntry() {
        return 'je-rev-1';
      },
      async recordPayment() {
        return 'je-pay-1';
      },
    };
    expect(typeof stub.createJournalEntry).toBe('function');
    expect(typeof stub.reverseJournalEntry).toBe('function');
    expect(typeof stub.recordPayment).toBe('function');
  });

  it('BD chart-of-accounts map exports the six codes the classytic bridge needs', () => {
    expect(BD_ACCOUNTS.receivable).toBe('1141');
    expect(BD_ACCOUNTS.payable).toBe('2111');
    expect(BD_ACCOUNTS.revenue).toBe('4111');
    expect(BD_ACCOUNTS.expense).toBe('5111');
    expect(BD_ACCOUNTS.taxPayable).toBe('2141');
    expect(BD_ACCOUNTS.cash).toBe('1112');
  });
});
