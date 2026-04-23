/**
 * POS Resource — thin channel on top of `@classytic/order`.
 *
 * POS is just an order channel, not a bespoke module. All order writes go
 * through the same `@classytic/order` engine as web checkout; POS only
 * owns the cashier-facing UX (product browse, barcode lookup, receipt).
 * Stock adjustment belongs on the inventory module — not on POS — so
 * that legacy route was intentionally removed.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import inventoryController from '#resources/inventory/inventory.controller.js';
import posController from './pos.controller.js';
import { createOrderSchema, lookupSchema, posProductsSchema, receiptSchema } from './pos.schemas.js';

const posResource = defineResource({
  name: 'pos',
  displayName: 'POS',
  tag: 'POS',
  prefix: '/pos',

  disableDefaultRoutes: true,

  routes: [
    {
      method: 'GET',
      path: '/products',
      summary: 'Browse products with branch stock',
      description:
        'Main POS catalog. Filter by category, search, inStockOnly, lowStockOnly. Returns products with branchStock.',
      permissions: permissions.pos.access,
      raw: true,
      schema: posProductsSchema,
      handler: inventoryController.getPosProducts,
    },
    {
      method: 'GET',
      path: '/lookup',
      summary: 'Barcode/SKU lookup',
      description: 'Fast lookup by barcode or SKU. Use for scanner input.',
      permissions: permissions.pos.access,
      raw: true,
      schema: lookupSchema,
      handler: inventoryController.lookup,
    },
    {
      method: 'POST',
      path: '/orders',
      summary: 'Create POS order',
      description: 'Cart-free cashier checkout. Delegates to @classytic/order pipeline.',
      permissions: permissions.pos.access,
      raw: true,
      schema: createOrderSchema,
      handler: posController.createOrder,
    },
    {
      method: 'GET',
      path: '/orders/:orderId/receipt',
      summary: 'Get receipt for a POS order',
      permissions: permissions.pos.access,
      raw: true,
      schema: receiptSchema,
      handler: posController.getReceipt,
    },
  ],
});

export default posResource;
