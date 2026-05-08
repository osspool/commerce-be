import {
  type CodCancellationData,
  codCancellationToPosting,
} from '../../posting/contracts/cod-cancellation.contract.js';
import { getOrderReferenceNumber } from '../../_shared/order-ref.service.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { CodCancelledEvent, codCancelledSchema } from '../event-definitions.js';

/**
 * Fired by `POST /orders/:id/action { action: 'cancel' }` when the
 * order was COD AND a settlement was NOT already recorded. Posts a
 * contra-entry that reverses the placement journal (Cr A/R, Dr Revenue
 * reversal). Orders that WERE settled use `/refund` instead — the
 * money is already in the bank and needs a cash-out entry, not an
 * A/R clearance.
 */
export const codCancelledHandler = definePostingHandler({
  event: CodCancelledEvent,
  payloadSchema: codCancelledSchema,

  async build(payload) {
    if (!payload.orderId || !payload.branchId) return null;
    if (payload.grossAmount <= 0) return null;

    const orderReferenceNumber = await getOrderReferenceNumber(payload.orderId);

    const data: CodCancellationData = {
      orderId: payload.orderId,
      orderReferenceNumber,
      customerId: payload.customerId ?? null,
      grossAmount: payload.grossAmount,
      tax: payload.tax,
      promoDiscount: payload.promoDiscount,
      date: payload.date ? new Date(payload.date) : new Date(),
      reason: payload.reason,
    };

    return {
      branchId: payload.branchId,
      posting: codCancellationToPosting(data),
      logFields: { orderId: payload.orderId, reason: payload.reason },
      successMessage: 'COD cancellation journal entry created (A/R reversed)',
    };
  },
});
