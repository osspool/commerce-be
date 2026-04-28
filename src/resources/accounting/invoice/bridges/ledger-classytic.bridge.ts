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
import mongoose from 'mongoose';
import accounting, { JournalEntry } from '../../accounting.engine.js';

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
 * `organizationId` stamping is handled by the engine itself via
 * `journalEntryOrgField: 'organizationId'` (see accounting.engine.ts).
 * This wrapper only stamps the two fields the package's generic bridge
 * doesn't know about: `sourceRef` (provenance link to the source invoice)
 * and `partnerId/partnerType` on the AR/AP control-account line (powers
 * customer / supplier statements via `journalItems.partnerId`).
 */
export function createClassyticLedgerBridge(): LedgerBridge {
  // biome-ignore lint/suspicious/noExplicitAny: package bridge accepts loose engine
  const inner = createLedgerBridge(accounting as any, {
    accounts: BD_ACCOUNTS,
    receiptAccount: BD_ACCOUNTS.cash,
  });

  async function stampSourceRef(jeId: string, sourceModel: string, sourceId: string): Promise<void> {
    await JournalEntry.updateOne(
      { _id: jeId },
      { $set: { 'sourceRef.sourceModel': sourceModel, 'sourceRef.sourceId': sourceId } },
    );
  }

  /**
   * Tag the receivable / payable line with `partnerId` + `partnerType`.
   *
   * The package's `record.adjustment` doesn't accept per-line partner
   * dimensions, but the JournalItem schema in our engine declares
   * `partnerId` + `partnerType` as `extraItemFields`. The partner-ledger
   * and aging reports key off these via `contactField: 'journalItems.partnerId'`,
   * so without this stamp customer statements would be empty.
   *
   * For customer-side moves, the partner sits on the DEBIT control-account
   * line (AR or cash); for vendor-side, on the CREDIT side (AP). We resolve
   * the right line by looking up the control account's ObjectId once and
   * matching `journalItems.account`.
   */
  async function stampPartner(
    jeId: string,
    partnerId: string,
    partnerType: 'customer' | 'vendor',
    accountTypeCode: string, // '1141' for AR, '2111' for AP, '1112' for cash
  ): Promise<void> {
    const Account = accounting.models.Account as {
      findOne: (q: Record<string, unknown>) => { lean: () => Promise<{ _id: unknown } | null> };
    };
    const acct = await Account.findOne({ accountTypeCode }).lean();
    if (!acct) return;
    const acctId = String((acct as { _id: { toString(): string } })._id);
    await JournalEntry.updateOne(
      { _id: jeId },
      { $set: { 'journalItems.$[item].partnerId': partnerId, 'journalItems.$[item].partnerType': partnerType } },
      { arrayFilters: [{ 'item.account': acctId }] },
    );
  }

  function controlAccount(moveType: string): string {
    if (moveType === 'receipt') return BD_ACCOUNTS.cash;
    if (moveType === 'in_invoice' || moveType === 'in_refund') return BD_ACCOUNTS.payable;
    return BD_ACCOUNTS.receivable; // out_invoice, out_refund
  }

  function partnerSide(moveType: string): 'customer' | 'vendor' {
    return moveType === 'in_invoice' || moveType === 'in_refund' ? 'vendor' : 'customer';
  }

  return {
    async createJournalEntry(input) {
      const id = await inner.createJournalEntry(input);
      await stampSourceRef(id, 'Invoice', input.invoiceId);
      if (input.partnerId) {
        await stampPartner(id, input.partnerId, partnerSide(input.moveType), controlAccount(input.moveType));
      }
      return id;
    },
    async reverseJournalEntry(journalEntryId, reason, ctx) {
      // Engine handles organizationId stamping on the reversal JE itself
      // (via journalEntryOrgField). No host-side stamping needed.
      return inner.reverseJournalEntry(journalEntryId, reason, ctx);
    },
    async recordPayment(input) {
      const id = await inner.recordPayment(input);
      await stampSourceRef(id, 'Invoice', input.invoiceId);
      // The payment JE has a control-account line (AR for customer-side,
      // AP for vendor-side) that mirrors the original invoice. Tag it with
      // the source invoice's partner so AR-aging by-partner stays correct
      // and the negative `contactId: null` slop row doesn't accumulate.
      // LedgerPaymentInput doesn't carry partnerId/moveType, so we look
      // them up off the source invoice via the same mongoose connection.
      const Invoice = mongoose.connection.collection('invoices');
      const sourceInv = (await Invoice.findOne({
        _id: mongoose.Types.ObjectId.isValid(input.invoiceId)
          ? new mongoose.Types.ObjectId(input.invoiceId)
          : (input.invoiceId as unknown as mongoose.Types.ObjectId),
      })) as { partnerId?: string; moveType?: string } | null;
      if (sourceInv?.partnerId && sourceInv.moveType) {
        await stampPartner(
          id,
          sourceInv.partnerId,
          partnerSide(sourceInv.moveType),
          controlAccount(sourceInv.moveType),
        );
      }
      return id;
    },
  };
}
