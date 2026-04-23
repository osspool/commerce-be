/**
 * Ledger bridge — @classytic/ledger adapter for the invoice engine.
 *
 * The invoice engine consumes the `LedgerBridge` port (packages/invoice/src/domain/contracts/ledger-bridge.ts)
 * — it does not depend on `@classytic/ledger` directly. This file is one
 * concrete implementation of that port, backed by our in-house ledger.
 *
 * To plug in a different ledger (QuickBooks, Xero, Odoo Accounting, manual),
 * create a sibling file:
 *
 *   bridges/ledger-quickbooks.bridge.ts  → implements `LedgerBridge` using Intuit's API
 *   bridges/ledger-xero.bridge.ts        → implements `LedgerBridge` using Xero's API
 *   bridges/ledger-noop.bridge.ts        → a stub for environments without a ledger
 *
 * Select which one wires into the engine in `invoice-engine.ts`. The port's
 * three methods (`createJournalEntry`, `reverseJournalEntry`, `recordPayment`)
 * are the entire surface area — no other ledger concerns leak in.
 */

import type { LedgerBridge } from '@classytic/invoice/domain/contracts';
import { createLedgerBridge } from '@classytic/ledger/sync';
import accounting from '../../accounting.engine.js';

/**
 * Bangladesh chart-of-account codes — maps invoice move types to the right GL account.
 * These align with `@classytic/ledger-bd`'s reference BD chart (1141 AR, 2111 AP, etc.).
 * A different country pack would supply its own account map.
 */
export const BD_ACCOUNTS = {
  receivable: '1141', // Accounts Receivable
  payable: '2111', // Accounts Payable
  revenue: '4111', // Sales Revenue
  expense: '5111', // Cost of Goods Sold
  taxPayable: '2141', // VAT Payable
  taxReceivable: '1151', // VAT Receivable (Input Tax)
  cash: '1112', // Bank Account (POS receipts debit here directly)
} as const;

/**
 * Build the classytic-ledger-backed `LedgerBridge` implementation.
 *
 * Unconditionally uses the BD chart mapping — if the deployment needs a
 * different chart, duplicate this file and swap the accounts map, or extract
 * the accounts argument once a second country is live.
 */
export function createClassyticLedgerBridge(): LedgerBridge {
  return createLedgerBridge(accounting as any, {
    accounts: BD_ACCOUNTS,
    receiptAccount: BD_ACCOUNTS.cash,
  });
}
