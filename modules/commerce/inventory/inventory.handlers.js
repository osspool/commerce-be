import mongoose from 'mongoose';
import { eventBus } from '#common/events/eventBus.js';
import branchRepository from '../branch/branch.repository.js';
import { stockSyncService } from './services/index.js';
import logger from '#common/utils/logger.js';

let handlersRegistered = false;

/**
 * Inventory Domain Event Handlers
 *
 * Subscribes to product domain events to keep inventory projections in sync.
 * This is intentionally decoupled via the domain event bus.
 *
 * Events handled:
 * - product:created → initialize stock entries for default branch
 * - product:variants.changed → set StockEntry.isActive for variant SKUs
 * - product:deleted → deactivate all stock entries for product
 * - product:restored → re-derive StockEntry.isActive from Product state
 * - product:before.purge → snapshot product data before destructive delete
 */
export function registerInventoryEventHandlers(options = {}) {
  const { force = false } = options;

  if (handlersRegistered && !force) {
    return;
  }
  handlersRegistered = true;

  // When product created → initialize stock entries for default branch
  eventBus.on('product:created', async ({ productId, productType, variants, sku }) => {
    try {
      const defaultBranch = await branchRepository.getDefaultBranch();
      const StockEntry = mongoose.model('StockEntry');

      if (productType === 'simple') {
        await StockEntry.updateOne(
          { product: productId, variantSku: null, branch: defaultBranch._id },
          {
            $setOnInsert: {
              product: productId,
              variantSku: null,
              branch: defaultBranch._id,
              quantity: 0,
              reservedQuantity: 0,
              reorderPoint: 0,
              reorderQuantity: 0,
              isActive: true,
            },
          },
          { upsert: true }
        );
      } else if (productType === 'variant' && variants?.length) {
        const ops = variants
          .filter(v => v?.sku)
          .map(v => ({
            updateOne: {
              filter: { product: productId, variantSku: v.sku, branch: defaultBranch._id },
              update: {
                $setOnInsert: {
                  product: productId,
                  variantSku: v.sku,
                  branch: defaultBranch._id,
                  quantity: 0,
                  reservedQuantity: 0,
                  reorderPoint: 0,
                  reorderQuantity: 0,
                  isActive: v.isActive !== false,
                },
              },
              upsert: true,
            },
          }));

        if (ops.length) {
          await StockEntry.bulkWrite(ops, { ordered: false });
        }
      }

      logger.info({ sku: sku || productId }, 'Initialized stock entries for product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to initialize stock entries');
    }
  });

  // When variants changed → update stock entry statuses
  eventBus.on('product:variants.changed', async ({ productId, disabledSkus, enabledSkus }) => {
    try {
      if (disabledSkus?.length > 0) {
        await stockSyncService.setVariantsActive(productId, disabledSkus, false);
      }
      if (enabledSkus?.length > 0) {
        await stockSyncService.setVariantsActive(productId, enabledSkus, true);
      }
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to update variant stock status');
    }
  });

  // When product deleted → deactivate all stock
  eventBus.on('product:deleted', async ({ productId, sku }) => {
    try {
      await stockSyncService.setProductStockActive(productId, false);
      logger.info({ sku: sku || productId }, 'Deactivated stock for deleted product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to deactivate product stock');
    }
  });

  // When product restored → reactivate all stock (derived from Product + Variant state)
  eventBus.on('product:restored', async ({ productId, sku }) => {
    try {
      await stockSyncService.syncProductStockIsActive(productId);
      logger.info({ sku: sku || productId }, 'Reactivated stock for restored product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to reactivate product stock');
    }
  });

  // When product about to be purged → snapshot product data
  eventBus.on('product:before.purge', async ({ product }) => {
    try {
      await stockSyncService.snapshotProductBeforeDelete(product);
      logger.info({ sku: product?.sku || product?._id }, 'Snapshotted product before purge');
    } catch (error) {
      logger.error({ err: error, productId: product?._id }, 'Failed to snapshot product before purge');
    }
  });
}
