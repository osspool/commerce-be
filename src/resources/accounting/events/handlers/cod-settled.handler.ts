import config from '#config/index.js';
import { type CodSettlementData, codSettlementToPosting } from '../../posting/contracts/cod-settlement.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { CodSettledEvent, codSettledSchema } from '../event-definitions.js';

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

    const data: CodSettlementData = {
      settlementId: payload.settlementId,
      orderId: payload.orderId,
      grossAmount: payload.grossAmount,
      actualReceived: payload.actualReceived,
      courierCommission: payload.courierCommission,
      writeoff: payload.writeoff,
      cashAccount: payload.cashAccount,
      date: payload.date ? new Date(payload.date) : new Date(),
      notes: payload.notes,
    };

    return {
      branchId: payload.branchId,
      posting: codSettlementToPosting(data, { autoPost: config.accounting.autoPost }),
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
