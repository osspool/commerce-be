import { BD } from '../../posting/bd-account-codes.js';
import { type CodSettlementData, codSettlementToPosting } from '../../posting/contracts/cod-settlement.contract.js';
import { getOrderRefAndCustomer } from '../../_shared/order-ref.service.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { CodSettledEvent, codSettledSchema } from '../event-definitions.js';

/**
 * Map the order layer's semantic cash intent → GL account. Chart-of-accounts
 * knowledge lives here (accounting tier), not in sales/orders. Accepts a raw
 * GL code too for forward-compat, defaulting to operating cash.
 */
function resolveCashAccount(intent: string | undefined): string {
  if (intent === 'petty_cash') return BD.pettyCash;
  if (intent === 'cash' || intent === undefined) return BD.cash;
  return intent; // already a GL code
}

/**
 * Fired by `POST /orders/:id/cod-settlement` after the admin enters the
 * actual amount remitted by the courier. The route already validated
 * the balance invariant `actualReceived + commission + writeoff = gross`
 * and persisted the settlement on `order.metadata.codSettlement`.
 *
 * Posts a second journal that clears the A/R from placement and debits
 * Bank + Courier Commission (+ optional Writeoff). Net trial-balance
 * impact across placement + settlement:
 *
 *   Dr Bank (received) + Dr Commission (kept) + Dr Writeoff
 *   Cr Revenue (full) + Cr VAT
 */
export const codSettledHandler = definePostingHandler({
  event: CodSettledEvent,
  payloadSchema: codSettledSchema,

  async build(payload, log) {
    if (!payload.orderId || !payload.settlementId) return null;
    if (!payload.branchId) {
      log.warn({ settlementId: payload.settlementId }, 'COD settlement missing branchId — skipping');
      return null;
    }

    const { referenceNumber: orderReferenceNumber, customerId } = await getOrderRefAndCustomer(payload.orderId);

    const data: CodSettlementData = {
      settlementId: payload.settlementId,
      orderId: payload.orderId,
      orderReferenceNumber,
      grossAmount: payload.grossAmount,
      actualReceived: payload.actualReceived,
      courierCommission: payload.courierCommission,
      writeoff: payload.writeoff,
      cashAccount: resolveCashAccount(payload.cashAccount),
      // Customer reference for the A/R clear line — must match the placement
      // entry's partnerId so the subsidiary ledger nets to zero. Null for
      // guest checkouts (placement also stamps no partnerId).
      customerId: customerId ?? undefined,
      date: payload.date ? new Date(payload.date) : new Date(),
      notes: payload.notes,
    };

    return {
      branchId: payload.branchId,
      posting: codSettlementToPosting(data),
      logFields: {
        orderId: payload.orderId,
        settlementId: payload.settlementId,
        actualReceived: payload.actualReceived,
        courierCommission: payload.courierCommission,
        writeoff: payload.writeoff,
      },
      successMessage: 'COD settlement journal entry created (A/R cleared → Bank + Commission + Writeoff)',
    };
  },
});
