import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import posController from './pos.controller.js';
import { inventoryController } from '../inventory/index.js';
import { branchController } from '../branch/index.js';
import {
  lookupSchema,
  createOrderSchema,
  receiptSchema,
  getProductStockSchema,
  setStockSchema,
  lowStockSchema,
  movementsSchema,
  bulkAdjustSchema,
  updateBarcodeSchema,
  labelDataSchema,
} from './pos.schemas.js';

/**
 * POS Plugin
 *
 * Registers POS-specific routes using createRoutes utility.
 * Uses controllers from branch and inventory modules to avoid duplication.
 *
 * All POS routes require staff authentication (admin or store-manager role)
 */
async function posPlugin(fastify) {
  // ============================================
  // POS ORDER & LOOKUP ROUTES
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/pos/lookup',
      summary: 'Lookup product by barcode or SKU',
      authRoles: ['admin', 'store-manager'],
      schema: lookupSchema,
      handler: inventoryController.lookup,
    },
    {
      method: 'POST',
      url: '/api/v1/pos/orders',
      summary: 'Create POS order (cart-free)',
      authRoles: ['admin', 'store-manager'],
      schema: createOrderSchema,
      handler: posController.createOrder,
    },
    {
      method: 'GET',
      url: '/api/v1/pos/orders/:orderId/receipt',
      summary: 'Get order receipt data',
      authRoles: ['admin', 'store-manager'],
      schema: receiptSchema,
      handler: posController.getReceipt,
    },
  ], { tag: 'POS', basePath: '/api/v1/pos' });

  // ============================================
  // INVENTORY ROUTES (within POS context)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/pos/inventory/:productId',
      summary: 'Get stock levels for a product',
      authRoles: ['admin', 'store-manager'],
      schema: getProductStockSchema,
      handler: inventoryController.getProductStock,
    },
    {
      method: 'PUT',
      url: '/api/v1/pos/inventory/:productId',
      summary: 'Set stock quantity',
      authRoles: ['admin', 'store-manager'],
      schema: setStockSchema,
      handler: inventoryController.setStock,
    },
    {
      method: 'GET',
      url: '/api/v1/pos/inventory/alerts/low-stock',
      summary: 'Get low stock items',
      authRoles: ['admin', 'store-manager'],
      schema: lowStockSchema,
      handler: inventoryController.getLowStock,
    },
    {
      method: 'GET',
      url: '/api/v1/pos/inventory/movements',
      summary: 'Get stock movement history',
      authRoles: ['admin', 'store-manager'],
      schema: movementsSchema,
      handler: inventoryController.getMovements,
    },
    // ============================================
    // BULK OPERATIONS (Square/Odoo-inspired)
    // ============================================
    {
      method: 'POST',
      url: '/api/v1/pos/inventory/adjust',
      summary: 'Bulk stock adjustment (set/add/remove)',
      description: 'Process multiple stock adjustments atomically. Modes: set (absolute), add (receive), remove (damage/shrinkage)',
      authRoles: ['admin', 'store-manager'],
      schema: bulkAdjustSchema,
      handler: inventoryController.bulkImport,
    },
    {
      method: 'PATCH',
      url: '/api/v1/pos/inventory/barcode',
      summary: 'Update barcode for product/variant',
      description: 'Assign or update barcode. Validates uniqueness across all products.',
      authRoles: ['admin', 'store-manager'],
      schema: updateBarcodeSchema,
      handler: inventoryController.updateBarcode,
    },
    {
      method: 'GET',
      url: '/api/v1/pos/inventory/labels',
      summary: 'Get label data for barcode printing',
      description: 'Returns formatted data for FE to render barcode labels. FE uses JsBarcode or similar.',
      authRoles: ['admin', 'store-manager'],
      schema: labelDataSchema,
      handler: inventoryController.getLabelData,
    },
  ], { tag: 'POS', basePath: '/api/v1/pos' });

  // ============================================
  // BRANCH ROUTES (within POS context)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/pos/branches',
      summary: 'List all active branches',
      authRoles: ['admin', 'store-manager'],
      handler: branchController.getActive,
    },
    {
      method: 'GET',
      url: '/api/v1/pos/branches/default',
      summary: 'Get default branch (auto-creates if none exists)',
      authRoles: ['admin', 'store-manager'],
      handler: branchController.getDefault,
    },
  ], { tag: 'POS', basePath: '/api/v1/pos' });
}

export default fp(posPlugin, {
  name: 'pos',
  dependencies: ['register-core-plugins'],
});
