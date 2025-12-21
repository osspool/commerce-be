import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import posController from './pos.controller.js';
import { inventoryController } from '../inventory/index.js';
import permissions from '#config/permissions.js';
import {
  posProductsSchema,
  lookupSchema,
  createOrderSchema,
  receiptSchema,
  adjustStockSchema,
} from './pos.schemas.js';

/**
 * POS Plugin - Simplified
 *
 * 5 Essential Endpoints for POS Operations:
 *
 * CATALOG:
 *   GET  /pos/products      - Browse products with branch stock (supports category, search, lowStock filter)
 *   GET  /pos/lookup        - Fast barcode/SKU scan
 *
 * ORDERS:
 *   POST /pos/orders        - Create order
 *   GET  /pos/orders/:id/receipt - Get receipt
 *
 * STOCK:
 *   POST /pos/stock/adjust  - Adjust stock (single or bulk)
 *
 * Note: For branch management, use /api/v1/branches/* (see branch-api.ts)
 */
async function posPlugin(fastify) {
  // ============================================
  // CATALOG - Browse & Search
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/pos/products',
      summary: 'Browse products with branch stock',
      description: 'Main POS catalog. Filter by category, search, inStockOnly, lowStockOnly. Returns products with branchStock.',
      authRoles: permissions.pos.access,
      schema: posProductsSchema,
      handler: inventoryController.getPosProducts,
    },
    {
      method: 'GET',
      url: '/pos/lookup',
      summary: 'Barcode/SKU lookup',
      description: 'Fast lookup by barcode or SKU. Use for scanner input.',
      authRoles: permissions.pos.access,
      schema: lookupSchema,
      handler: inventoryController.lookup,
    },
  ], { tag: 'POS' });

  // ============================================
  // ORDERS - Checkout & Receipt
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/pos/orders',
      summary: 'Create POS order',
      description: 'Cart-free checkout. Supports pickup (immediate) or delivery.',
      authRoles: permissions.pos.access,
      schema: createOrderSchema,
      handler: posController.createOrder,
    },
    {
      method: 'GET',
      url: '/pos/orders/:orderId/receipt',
      summary: 'Get receipt',
      authRoles: permissions.pos.access,
      schema: receiptSchema,
      handler: posController.getReceipt,
    },
  ], { tag: 'POS' });

  // ============================================
  // STOCK - Adjustment
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/pos/stock/adjust',
      summary: 'Adjust stock',
      description: 'Set, add, or remove stock. Supports single item or bulk (up to 500).',
      authRoles: permissions.inventory.adjust,
      schema: adjustStockSchema,
      handler: inventoryController.bulkImport,
    },
  ], { tag: 'POS' });

}

export default fp(posPlugin, {
  name: 'pos',
  dependencies: ['register-core-plugins'],
});
