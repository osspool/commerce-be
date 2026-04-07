/**
 * Stock Transaction Service — Flow-powered
 *
 * Provides stock decrement (shipment) and restore (return) operations
 * using @classytic/flow MoveGroups.
 *
 * This is the inventory module's public API for stock mutations.
 * External modules (POS, orders, fulfillment) call these methods.
 *
 * Flow naming conventions:
 * - Decrement = shipment MoveGroup (stock → customer)
 * - Restore = return MoveGroup (customer → stock)
 * - All operations create immutable StockMove audit trail
 */
import {
  getFlowEngine,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  CUSTOMER_LOCATION,
} from '../flow/index.js';
import logger from '#lib/utils/logger.js';

interface StockItem {
  productId: string;
  variantSku?: string;
  quantity: number;
}

interface Reference {
  model: string;
  id?: string | { toString(): string };
}

interface DecrementResult {
  success: boolean;
  moveGroupId?: unknown;
  error?: string;
  decrementedItems: Array<{
    productId: string;
    variantSku?: string;
    quantity: number;
  }>;
}

interface RestoreResult {
  success: boolean;
  moveGroupId?: unknown;
  error?: string;
  restoredItems: Array<{
    productId: string;
    variantSku?: string;
    quantity: number;
  }>;
}

class StockTransactionService {
  /**
   * Create and execute a shipment MoveGroup to decrement stock.
   */
  async decrementBatch(
    items: StockItem[],
    branchId: string,
    reference: Reference | undefined,
    actorId: string,
  ): Promise<DecrementResult> {
    try {
      const flow = getFlowEngine();
      const ctx = buildFlowContext(branchId, actorId);

      const group = await flow.services.moveGroup.create(
        {
          groupType: 'shipment',
          items: items.map((item) => ({
            moveGroupId: '',
            operationType: 'shipment',
            skuRef: skuRefFromProduct(item.productId, item.variantSku),
            sourceLocationId: DEFAULT_LOCATION,
            destinationLocationId: CUSTOMER_LOCATION,
            quantityPlanned: item.quantity,
          })),
          metadata: reference
            ? { referenceModel: reference.model, referenceId: String(reference.id ?? '') }
            : undefined,
        },
        ctx,
      );

      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);

      return {
        success: true,
        moveGroupId: group._id,
        decrementedItems: items.map((item) => ({
          productId: item.productId,
          variantSku: item.variantSku,
          quantity: item.quantity,
        })),
      };
    } catch (error) {
      logger.error({ err: error, branchId, itemCount: items.length }, 'Stock decrement failed');
      return { success: false, error: (error as Error).message, decrementedItems: [] };
    }
  }

  /**
   * Create and execute a return MoveGroup to restore stock.
   */
  async restoreBatch(
    items: StockItem[],
    branchId: string,
    reference: Reference | undefined,
    actorId: string,
  ): Promise<RestoreResult> {
    try {
      const flow = getFlowEngine();
      const ctx = buildFlowContext(branchId, actorId);

      const group = await flow.services.moveGroup.create(
        {
          groupType: 'return',
          items: items.map((item) => ({
            moveGroupId: '',
            operationType: 'return',
            skuRef: skuRefFromProduct(item.productId, item.variantSku),
            sourceLocationId: CUSTOMER_LOCATION,
            destinationLocationId: DEFAULT_LOCATION,
            quantityPlanned: item.quantity,
          })),
          metadata: reference
            ? { referenceModel: reference.model, referenceId: String(reference.id ?? '') }
            : undefined,
        },
        ctx,
      );

      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);

      return {
        success: true,
        moveGroupId: group._id,
        restoredItems: items.map((item) => ({
          productId: item.productId,
          variantSku: item.variantSku,
          quantity: item.quantity,
        })),
      };
    } catch (error) {
      logger.error({ err: error, branchId, itemCount: items.length }, 'Stock restore failed');
      return { success: false, error: (error as Error).message, restoredItems: [] };
    }
  }
}

export default new StockTransactionService();
