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
 * - Decrement = shipment MoveGroup (stock -> customer)
 * - Restore = return MoveGroup (customer -> stock)
 * - All operations create immutable StockMove audit trail
 */

import logger from '#lib/utils/logger.js';
import { buildFlowContext, CUSTOMER_LOCATION, DEFAULT_LOCATION, skuRefFromProduct } from '../flow/context-helpers.js';
import { getFlowEngine } from '../flow/flow-engine.js';
import {
  createLocationCache,
  LocationResolutionError,
  resolveLocationCode,
} from '../flow/location-resolver.js';
import type { StockMutationResult, StockOperationItem, StockReference } from '../types/stock-operations.js';

class StockTransactionService {
  /**
   * Create and execute a shipment MoveGroup to decrement stock.
   */
  async decrementBatch(
    items: StockOperationItem[],
    branchId: string,
    reference: StockReference | undefined,
    actorId: string,
  ): Promise<StockMutationResult> {
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
        moveGroupIds: [String(group._id)],
        items: items.map((item) => ({
          productId: item.productId,
          variantSku: item.variantSku ?? undefined,
          quantity: item.quantity,
        })),
      };
    } catch (error) {
      logger.error({ err: error, branchId, itemCount: items.length }, 'Stock decrement failed');
      return { success: false, moveGroupIds: [], error: (error as Error).message, items: [] };
    }
  }

  /**
   * Create and execute a return MoveGroup to restore stock.
   *
   * Each item may carry `destinationLocationId` to route the returned
   * goods to a specific physical bin (QC, restock, scrap, RTV) — falls
   * back to the branch default `stock` bin when omitted. Mirrors the
   * per-line location pattern on transfer + purchase (Batch A-B). Bin
   * IDs are resolved to Flow location codes via the shared resolver
   * (cache shared across the batch — one DB hit per unique bin).
   */
  async restoreBatch(
    items: StockOperationItem[],
    branchId: string,
    reference: StockReference | undefined,
    actorId: string,
  ): Promise<StockMutationResult> {
    try {
      const flow = getFlowEngine();
      const ctx = buildFlowContext(branchId, actorId);
      const locationCache = createLocationCache();

      // Resolve every per-line bin id up front. Lines without an override
      // skip the lookup and use the default stock code directly.
      const resolvedItems = await Promise.all(
        items.map(async (item) => {
          const destinationLocationId = await resolveLocationCode(
            flow,
            item.destinationLocationId,
            ctx,
            { cache: locationCache },
          );
          return {
            moveGroupId: '',
            operationType: 'return' as const,
            skuRef: skuRefFromProduct(item.productId, item.variantSku),
            sourceLocationId: CUSTOMER_LOCATION,
            destinationLocationId,
            quantityPlanned: item.quantity,
          };
        }),
      );

      const group = await flow.services.moveGroup.create(
        {
          groupType: 'return',
          items: resolvedItems,
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
        moveGroupIds: [String(group._id)],
        items: items.map((item) => ({
          productId: item.productId,
          variantSku: item.variantSku ?? undefined,
          quantity: item.quantity,
        })),
      };
    } catch (error) {
      // Caller-supplied invalid `destinationLocationId` surfaces as a
      // 4xx-style error string rather than a 500 — preserves API ergonomics
      // for the sales-side `processRefund` callers.
      if (error instanceof LocationResolutionError) {
        logger.warn(
          { err: error.message, branchId, itemCount: items.length },
          'Stock restore rejected: invalid destinationLocationId',
        );
        return { success: false, moveGroupIds: [], error: error.message, items: [] };
      }
      logger.error({ err: error, branchId, itemCount: items.length }, 'Stock restore failed');
      return { success: false, moveGroupIds: [], error: (error as Error).message, items: [] };
    }
  }
}

export default new StockTransactionService();
