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
import { createOrderSchema, lookupSchema, posProductsSchema } from './pos.schemas.js';

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
    // Receipt rendering is client-side: the FE transforms an Order doc via
    // `transformOrderToReceipt(order, branchInfo)` (see fe-bigboss
    // commerce/pos/utils/pos-helpers.ts). The previous /orders/:id/receipt
    // endpoint was removed — it returned the wrong shape (raw order, not
    // PosReceiptData) and added no value over reading the order doc directly.
  ],
});

export default posResource;
