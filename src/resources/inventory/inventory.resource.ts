/**
 * Inventory Ops Resource — adjustments, movements, low-stock
 */
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import inventoryController from './inventory.controller.js';
import { adjustmentSchemaZod, movementSchemas } from './inventory-flow.schemas.js';

const inventoryOpsResource = defineResource({
  name: 'inventory',
  displayName: 'Inventory',
  tag: 'Inventory',
  prefix: '/inventory',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/low-stock',
      summary: 'Get low-stock items for a branch',
      description: 'Returns items at or below reorder threshold.',
      permissions: permissions.inventory.alerts,
      raw: true,
      tags: ['Inventory - Stock'],
      handler: inventoryController.getLowStock.bind(inventoryController),
    },
    {
      method: 'GET',
      path: '/movements',
      summary: 'Get stock movements',
      description: 'Query stock movement audit trail.',
      permissions: permissions.inventory.movements,
      raw: true,
      tags: ['Inventory - Stock'],
      schema: movementSchemas.list,
      handler: inventoryController.getMovements.bind(inventoryController),
    },
    {
      method: 'GET',
      path: '/movements/export',
      summary: 'Export stock movements to CSV',
      permissions: permissions.inventory.movements,
      raw: true,
      tags: ['Inventory - Stock'],
      handler: inventoryController.exportMovements.bind(inventoryController),
    },
    {
      method: 'POST',
      path: '/adjustments',
      summary: 'Adjust stock (single or bulk)',
      description: 'Create manual stock adjustment.',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: adjustmentSchemaZod,
      tags: ['Inventory - Adjustments'],
      handler: inventoryController.bulkImport.bind(inventoryController),
    },
  ],
});

export default inventoryOpsResource;
