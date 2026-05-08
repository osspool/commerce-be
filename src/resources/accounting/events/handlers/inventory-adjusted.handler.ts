import { type StockAdjustmentData, stockAdjustmentToPosting } from '../../posting/contracts/inventory.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { InventoryAdjustedEvent, inventoryAdjustedSchema } from '../event-definitions.js';

export const inventoryAdjustedHandler = definePostingHandler({
  event: InventoryAdjustedEvent,
  payloadSchema: inventoryAdjustedSchema,

  async build(payload, log) {
    if (!payload.amount) return null;
    if (!payload.branchId) {
      log.warn({ adjustmentId: payload.adjustmentId }, 'Adjustment has no branchId, skipping accounting');
      return null;
    }

    const data: StockAdjustmentData = {
      adjustmentId: payload.adjustmentId,
      referenceNumber: payload.referenceNumber,
      type: payload.type,
      amount: payload.amount,
      date: payload.date ? new Date(payload.date) : new Date(),
      reason: payload.reason,
      ...(payload.source ? { sourceModel: payload.source.sourceModel, sourceId: payload.source.sourceId } : {}),
    };

    return {
      branchId: payload.branchId,
      posting: stockAdjustmentToPosting(data),
      logFields: { adjustmentId: payload.adjustmentId, type: payload.type },
      successMessage: 'Inventory adjustment journal entry created',
    };
  },
});
