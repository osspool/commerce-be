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
// `createLedgerBridge` was hosted at `@classytic/ledger/sync` until
// ledger 0.11.0; the subpath was removed and the helper moved into the
// host (PACKAGE_RULES P1 — ledger cannot depend on `@classytic/invoice`).
import { createLedgerBridge } from '#shared/ledger-sync/ledger-bridge.js';
import { BD_ACCOUNT_CODES } from '@classytic/ledger-bd';
import mongoose from 'mongoose';
import accounting, { JournalEntry } from '../../accounting.engine.js';

/**
 * Bangladesh chart-of-account codes — maps invoice move types to the right GL account.
 * Canonical mappings live in `@classytic/ledger-bd` `BD_ACCOUNT_CODES`; the
 * shape this bridge needs (`receivable / payable / revenue / expense /
 * taxPayable / taxReceivable / cash`) is `@classytic/ledger`'s contract,
 * so we adapt domain-named keys to the bridge's expected ones here.
 *
 * Pre-0.2.2 this map had two pre-existing bugs: `taxPayable` pointed at
 * `2141` (Land Development Tax) instead of `2132` (VAT Output Payable),
 * and `cash` pointed at `1112` (Cash in Hand — Foreign Currency) instead
 * of `1113` (Cash at Bank — Current Account). Both fixed by routing
 * through the canonical `BD_ACCOUNT_CODES`.
 */

export const BD_ACCOUNTS = {
  receivable: BD_ACCOUNT_CODES.AR,
  payable: BD_ACCOUNT_CODES.AP,
  revenue: BD_ACCOUNT_CODES.SALES_REVENUE,
  expense: BD_ACCOUNT_CODES.COGS_MATERIALS,
  taxPayable: BD_ACCOUNT_CODES.VAT_OUTPUT_PAYABLE,
  taxReceivable: BD_ACCOUNT_CODES.VAT_RECEIVABLE,
  cash: BD_ACCOUNT_CODES.CASH,
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
    partnerType: 'customer' | 'supplier',
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

  // Canonical partner taxonomy: { 'customer' | 'supplier' }. Earlier
  // revisions used 'vendor' here, which broke PartnerResolver (resolves
  // 'supplier' against the Supplier model) — so AP-aging + vendor-bills
  // showed bare ObjectIds. Aligned terminology with the resolver and the
  // Mongoose Supplier model name.
  function partnerSide(moveType: string): 'customer' | 'supplier' {
    return moveType === 'in_invoice' || moveType === 'in_refund' ? 'supplier' : 'customer';
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
      //
      // `moveType` arrives on `input` since invoice@0.3.0 — no extra fetch
      // needed for that side. We still re-read the invoice for `partnerId`
      // because `LedgerPaymentInput` doesn't carry it (could be deferred to
      // a future invoice release; today it's a single indexed lookup).
      const moveType = input.moveType;
      const Invoice = mongoose.connection.collection('invoices');
      const sourceInv = (await Invoice.findOne({
        _id: mongoose.Types.ObjectId.isValid(input.invoiceId)
          ? new mongoose.Types.ObjectId(input.invoiceId)
          : (input.invoiceId as unknown as mongoose.Types.ObjectId),
      })) as { partnerId?: string; moveType?: string } | null;
      const effectiveMoveType = moveType ?? sourceInv?.moveType;
      if (sourceInv?.partnerId && effectiveMoveType) {
        await stampPartner(
          id,
          sourceInv.partnerId,
          partnerSide(effectiveMoveType),
          controlAccount(effectiveMoveType),
        );
      }
      return id;
    },
  };
}
