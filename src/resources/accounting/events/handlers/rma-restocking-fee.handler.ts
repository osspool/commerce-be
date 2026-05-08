import {
  type RestockingFeeData,
  restockingFeeToPosting,
} from '../../posting/contracts/restocking-fee.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import {
  RmaRestockingFeeCollectedEvent,
  rmaRestockingFeeCollectedSchema,
} from '../event-definitions.js';

/**
 * Posts the restocking-fee JE on a confirmed RMA — `Dr Cash | Cr 4319 Restocking
 * Fee Income` for the merchant-retained handling fee.
 *
 * Independent of the goods-restock + COGS-reversal pipeline so RMA economics
 * (fee coverage of return-handling cost) report on its own GL line. Only
 * posts when `amount > 0` — the lifecycle bridge filters zero-fee changes.
 *
 * Idempotent at the posting layer via `restocking-fee-${changeNumber}`.
 */
export const rmaRestockingFeeCollectedHandler = definePostingHandler({
  event: RmaRestockingFeeCollectedEvent,
  payloadSchema: rmaRestockingFeeCollectedSchema,

  async build(payload, log) {
    if (!payload.amount || payload.amount <= 0) return null;
    if (!payload.branchId) {
      log.warn(
        { changeNumber: payload.changeNumber },
        'rma.restocking_fee_collected missing branchId — skipping',
      );
      return null;
    }

    const data: RestockingFeeData = {
      changeNumber: payload.changeNumber,
      orderId: payload.orderId,
      amount: payload.amount,
      paymentMethod: payload.paymentMethod,
      date: payload.date ? new Date(payload.date) : new Date(),
      reason: payload.reason,
    };

    return {
      branchId: payload.branchId,
      posting: restockingFeeToPosting(data),
      logFields: {
        changeNumber: payload.changeNumber,
        orderId: payload.orderId,
        amount: payload.amount,
        paymentMethod: payload.paymentMethod,
      },
      successMessage: 'Restocking fee journal entry created (Dr Cash | Cr 4319)',
    };
  },
});
