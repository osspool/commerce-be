import { defineResource } from '@classytic/arc';
import posController from './pos.controller.js';
import { inventoryController } from '#modules/inventory/index.js';
import permissions from '#config/permissions.js';
import {
  posProductsSchema,
  lookupSchema,
  createOrderSchema,
  receiptSchema,
  adjustStockSchema,
} from './pos.schemas.js';

const posResource = defineResource({
  name: 'pos',
  displayName: 'POS',
  tag: 'POS',
  prefix: '/pos',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/products',
      summary: 'Browse products with branch stock',
      description: 'Main POS catalog. Filter by category, search, inStockOnly, lowStockOnly. Returns products with branchStock.',
      permissions: permissions.pos.access,
      wrapHandler: false,
      schema: posProductsSchema,
      handler: inventoryController.getPosProducts,
    },
    {
      method: 'GET',
      path: '/lookup',
      summary: 'Barcode/SKU lookup',
      description: 'Fast lookup by barcode or SKU. Use for scanner input.',
      permissions: permissions.pos.access,
      wrapHandler: false,
      schema: lookupSchema,
      handler: inventoryController.lookup,
    },
    {
      method: 'POST',
      path: '/orders',
      summary: 'Create POS order',
      description: 'Cart-free checkout. Supports pickup (immediate) or delivery.',
      permissions: permissions.pos.access,
      wrapHandler: false,
      schema: createOrderSchema,
      handler: posController.createOrder,
    },
    {
      method: 'GET',
      path: '/orders/:orderId/receipt',
      summary: 'Get receipt',
      permissions: permissions.pos.access,
      wrapHandler: false,
      schema: receiptSchema,
      handler: posController.getReceipt,
    },
    {
      method: 'POST',
      path: '/stock/adjust',
      summary: 'Adjust stock',
      description: 'Set, add, or remove stock. Supports single item or bulk (up to 500).',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: adjustStockSchema,
      handler: inventoryController.bulkImport,
    },
  ],
});

export default posResource;
