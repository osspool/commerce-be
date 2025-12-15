import BaseController from '#common/controllers/baseController.js';
import inventoryRepository from './inventory.repository.js';
import inventoryService from './inventory.service.js';
import { inventorySchemaOptions } from './inventory.schemas.js';
import { branchRepository } from '../branch/index.js';
import productRepository from '../product/product.repository.js';

/**
 * Inventory Controller
 *
 * Extends BaseController for auto query/pagination handling.
 * Additional methods for stock-specific operations.
 */
class InventoryController extends BaseController {
  constructor() {
    super(inventoryRepository, inventorySchemaOptions);

    // Bind additional methods
    this.lookup = this.lookup.bind(this);
    this.getProductStock = this.getProductStock.bind(this);
    this.setStock = this.setStock.bind(this);
    this.bulkImport = this.bulkImport.bind(this);
    this.updateBarcode = this.updateBarcode.bind(this);
    this.getLabelData = this.getLabelData.bind(this);
    this.getLowStock = this.getLowStock.bind(this);
    this.getMovements = this.getMovements.bind(this);
  }

  // ============================================
  // POS LOOKUP
  // ============================================

  async lookup(req, reply) {
    const { code } = req.query;

    if (!code || code.trim().length < 2) {
      return reply.code(400).send({
        success: false,
        message: 'Code must be at least 2 characters',
      });
    }

    const entry = await this.service.getByBarcodeOrSku(code);

    if (!entry) {
      return reply.code(404).send({
        success: false,
        message: 'Product not found',
      });
    }

    return reply.send({
      success: true,
      data: {
        product: entry.product,
        variantSku: entry.variantSku,
        quantity: entry.quantity,
        source: 'inventory',
      },
    });
  }

  // ============================================
  // STOCK OPERATIONS
  // ============================================

  async getProductStock(req, reply) {
    const { productId } = req.params;
    const { branchId } = req.query;

    const stock = await this.service.getProductStock(productId, branchId);

    return reply.send({
      success: true,
      data: stock,
    });
  }

  async setStock(req, reply) {
    const { productId } = req.params;
    const { variantSku, branchId, quantity, notes } = req.body;

    // Resolve branch
    const branch = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid branch',
      });
    }

    const result = await this.service.setStock(
      productId,
      variantSku || null,
      branch._id,
      quantity,
      notes,
      req.user?._id
    );

    return reply.send({
      success: true,
      data: result,
      message: 'Stock updated successfully',
    });
  }

  async getLowStock(req, reply) {
    const { branchId, threshold } = req.query;

    const items = await this.service.getLowStock(
      branchId,
      threshold ? parseInt(threshold) : null
    );

    return reply.send({
      success: true,
      data: items,
    });
  }

  async getMovements(req, reply) {
    const { productId, branchId, type, startDate, endDate, page, limit } = req.query;

    const result = await this.service.getMovements(
      { productId, branchId, type, startDate, endDate },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 50 }
    );

    return reply.send({
      success: true,
      ...result,
    });
  }

  // ============================================
  // BULK OPERATIONS (Square/Odoo-inspired)
  // ============================================

  /**
   * Bulk stock adjustment - Process multiple adjustments atomically
   * POST /pos/inventory/adjust
   *
   * Supports three modes:
   * - 'set': Set absolute quantity (for recount)
   * - 'add': Increment quantity (receiving stock)
   * - 'remove': Decrement quantity (damage/shrinkage)
   *
   * FE workflow: Scan products → queue adjustments → submit batch
   *
   * @body {Array} adjustments - Array of { productId, variantSku?, quantity, mode, reason?, barcode? }
   * @body {string} branchId - Branch for all adjustments (optional, uses default)
   * @body {string} reason - Default reason for all adjustments
   */
  async bulkImport(req, reply) {
    const { adjustments, branchId, reason: defaultReason } = req.body;

    if (!adjustments?.length) {
      return reply.code(400).send({
        success: false,
        message: 'Adjustments array is required',
      });
    }

    if (adjustments.length > 500) {
      return reply.code(400).send({
        success: false,
        message: 'Maximum 500 adjustments per request',
      });
    }

    // Resolve branch once for all
    const branch = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid branch',
      });
    }

    const results = {
      success: [],
      failed: [],
    };

    // Process each adjustment
    for (const adj of adjustments) {
      try {
        const {
          productId,
          variantSku,
          quantity,
          mode = 'set',
          reason,
          barcode,
        } = adj;

        if (!productId || quantity === undefined) {
          results.failed.push({
            ...adj,
            error: 'productId and quantity are required',
          });
          continue;
        }

        let newQuantity;

        if (mode === 'set') {
          // Absolute set
          newQuantity = quantity;
        } else if (mode === 'add' || mode === 'remove') {
          // Get current stock first
          const current = await this.service.getProductStock(productId, branch._id);
          const entry = current.find(e =>
            (e.variantSku || null) === (variantSku || null)
          );
          const currentQty = entry?.quantity || 0;

          newQuantity = mode === 'add'
            ? currentQty + quantity
            : Math.max(0, currentQty - quantity);
        } else {
          results.failed.push({
            ...adj,
            error: `Invalid mode: ${mode}. Use 'set', 'add', or 'remove'`,
          });
          continue;
        }

        // Update stock
        const result = await this.service.setStock(
          productId,
          variantSku || null,
          branch._id,
          newQuantity,
          reason || defaultReason || `Bulk ${mode}`,
          req.user?._id
        );

        // Update barcode if provided (during initial load)
        if (barcode && result) {
          await this.service.updateStockEntryBarcode(productId, variantSku, branch._id, barcode);
        }

        results.success.push({
          productId,
          variantSku,
          previousQuantity: mode === 'set' ? undefined : (newQuantity - quantity),
          newQuantity,
          mode,
        });
      } catch (error) {
        results.failed.push({
          ...adj,
          error: error.message,
        });
      }
    }

    return reply.send({
      success: true,
      data: {
        processed: results.success.length,
        failed: results.failed.length,
        results,
      },
      message: `Processed ${results.success.length} adjustments, ${results.failed.length} failed`,
    });
  }

  /**
   * Update barcode for product or variant
   * PATCH /pos/inventory/barcode
   *
   * For assigning custom barcodes to products.
   * FE can generate barcodes or user can input existing ones.
   */
  async updateBarcode(req, reply) {
    const { productId, variantSku, barcode } = req.body;

    if (!productId || !barcode) {
      return reply.code(400).send({
        success: false,
        message: 'productId and barcode are required',
      });
    }

    // Validate barcode uniqueness
    const existing = await this.service.getByBarcodeOrSku(barcode);
    if (existing && existing.product._id.toString() !== productId) {
      return reply.code(409).send({
        success: false,
        message: 'Barcode already assigned to another product',
      });
    }

    // Update on product
    if (variantSku) {
      // Update variant barcode
      await productRepository.updateVariantBarcode(productId, variantSku, barcode);
    } else {
      // Update product-level barcode
      await productRepository.update(productId, { barcode });
    }

    // Also update on stock entry if exists
    const branchId = (await branchRepository.getDefaultBranch())._id;
    await this.service.updateStockEntryBarcode(productId, variantSku, branchId, barcode);

    return reply.send({
      success: true,
      message: 'Barcode updated successfully',
    });
  }

  /**
   * Get label data for printing
   * GET /pos/inventory/labels?productIds=x,y,z&variantSkus=a,b,c
   *
   * Returns formatted data for barcode label printing.
   * FE renders labels using JsBarcode or similar library.
   *
   * Label data includes: SKU, barcode, name, price, variant info
   */
  async getLabelData(req, reply) {
    const { productIds, variantSkus, branchId } = req.query;

    if (!productIds && !variantSkus) {
      return reply.code(400).send({
        success: false,
        message: 'Provide productIds or variantSkus',
      });
    }

    const labels = [];
    const ids = productIds?.split(',').filter(Boolean) || [];
    const skus = variantSkus?.split(',').filter(Boolean) || [];

    // Fetch products
    if (ids.length) {
      const products = await productRepository.getAll({
        _id: { $in: ids },
      }, { limit: 100 });

      for (const product of products.docs || products) {
        // Simple product label
        if (!product.variations?.length) {
          labels.push({
            productId: product._id,
            sku: product.sku,
            barcode: product.barcode || product.sku,
            name: product.name,
            price: product.basePrice,
            currentPrice: product.currentPrice || product.basePrice,
          });
        } else {
          // Variant labels
          for (const variation of product.variations) {
            for (const option of variation.options) {
              labels.push({
                productId: product._id,
                variantSku: option.sku,
                barcode: option.barcode || option.sku,
                name: product.name,
                variant: `${variation.name}: ${option.value}`,
                price: product.basePrice + (option.priceModifier || 0),
                currentPrice: (product.currentPrice || product.basePrice) + (option.priceModifier || 0),
              });
            }
          }
        }
      }
    }

    // Fetch by SKUs directly
    if (skus.length) {
      for (const sku of skus) {
        const entry = await this.service.getByBarcodeOrSku(sku);
        if (entry?.product) {
          const product = entry.product;
          const variant = entry.matchedVariant;

          labels.push({
            productId: product._id,
            variantSku: entry.variantSku,
            barcode: variant?.option?.barcode || entry.variantSku || product.barcode,
            name: product.name,
            variant: variant ? `${variant.variationName}: ${variant.option.value}` : undefined,
            price: product.basePrice + (variant?.option?.priceModifier || 0),
            currentPrice: (product.currentPrice || product.basePrice) + (variant?.option?.priceModifier || 0),
            quantity: entry.quantity,
          });
        }
      }
    }

    return reply.send({
      success: true,
      data: labels,
    });
  }
}

export default new InventoryController();
