import mongoose from 'mongoose';
import { type PurchaseData, purchaseToPosting } from '../../posting/contracts/purchase.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { PurchasePaidEvent, purchasePaidSchema } from '../event-definitions.js';

export const purchasePaidHandler = definePostingHandler({
  event: PurchasePaidEvent,
  payloadSchema: purchasePaidSchema,

  async build(payload, log) {
    if (!payload.purchaseId || !payload.amount) return null;

    // Resolve branchId from purchase document when not on the payload —
    // older event sources that only carry `purchaseId`.
    let branchId = payload.branchId;
    if (!branchId) {
      const purchase = await mongoose.connection.db
        ?.collection('purchase_orders')
        .findOne({ _id: new mongoose.Types.ObjectId(payload.purchaseId) }, { projection: { branch: 1 } });
      branchId = (purchase?.branch as { toString: () => string } | undefined)?.toString();
    }

    if (!branchId) {
      log.warn({ purchaseId: payload.purchaseId }, 'Purchase has no branch, skipping accounting');
      return null;
    }

    const data: PurchaseData = {
      purchaseId: payload.purchaseId,
      supplierId: '', // not needed for posting
      totalAmount: payload.amount,
      tax: payload.tax ?? 0,
      vatRate: payload.vatRate,
      date: new Date(),
      inventoryType: payload.inventoryType,
      isPaid: payload.isPaid ?? true,
      currency: payload.currency,
      exchangeRate: payload.exchangeRate,
      foreignTotal: payload.foreignTotal,
    };

    return {
      branchId,
      posting: purchaseToPosting(data),
      logFields: { purchaseId: payload.purchaseId },
      successMessage: 'Purchase journal entry created',
    };
  },
});
