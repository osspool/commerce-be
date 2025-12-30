/**
 * Inventory Module Routes
 *
 * Main plugin entry point for the inventory module.
 * Registers all submodule routes under /inventory prefix.
 */

import fp from 'fastify-plugin';
import { createRoutes } from '#core/factories/createRoutes.js';
import createCrudRouter from '#core/factories/createCrudRouter.js';
import { createActionRouter } from '#core/factories/createActionRouter.js';
import permissions from '#config/permissions.js';
import { paginateWrapper, itemWrapper } from '#core/docs/responseSchemas.js';

// Import submodule routes
import stockRoutes from './stock/routes.js';
import purchaseRoutes from './purchase/routes.js';

// Import controllers and schemas
import { transferController, transferSchemas } from './transfer/index.js';
import { stockRequestController, stockRequestSchemas } from './stock-request/index.js';
import { supplierController, supplierSchemas, supplierEntitySchema } from './supplier/index.js';

// Import action registry
import { inventoryActionRegistry } from './inventory.actions.js';

/**
 * Inventory Management Plugin
 *
 * Industry-standard minimal API following Stripe/Square patterns.
 * Action-based state transitions for workflow entities.
 */
async function inventoryRoutes(fastify) {
  // ============================================
  // STOCK SUBMODULE (movements, adjustments)
  // ============================================
  await fastify.register(stockRoutes);

  // ============================================
  // SUPPLIERS
  // ============================================
  fastify.register(async (instance) => {
    createCrudRouter(instance, supplierController, {
      tag: 'Inventory - Suppliers',
      basePath: '/api/v1/inventory/suppliers',
      schemas: {
        ...supplierSchemas,
        entity: supplierEntitySchema,
      },
      auth: {
        list: permissions.inventory.supplierView,
        get: permissions.inventory.supplierView,
        create: permissions.inventory.supplierManage,
        update: permissions.inventory.supplierManage,
        remove: permissions.inventory.supplierManage,
      },
    });
  }, { prefix: '/suppliers' });

  // ============================================
  // PURCHASES (Head Office Stock Entry)
  // ============================================
  await fastify.register(purchaseRoutes, { prefix: '/purchases' });

  // ============================================
  // ACTION ROUTERS (Stripe Pattern)
  // ============================================
  for (const actionConfig of inventoryActionRegistry) {
    fastify.register((instance, _opts, done) => {
      instance.addHook('preHandler', instance.authenticate);
      createActionRouter(instance, actionConfig);
      done();
    }, { prefix: actionConfig.prefix.replace('/inventory', '') });
  }

  // ============================================
  // TRANSFERS (Challan Workflow)
  // ============================================
  fastify.register(async (instance) => {
    createRoutes(instance, [
      {
        method: 'POST',
        url: '/',
        summary: 'Create stock transfer (challan)',
        description: 'Create a new transfer from head office to sub-branch. Returns draft challan.',
        authRoles: permissions.inventory.transferCreate,
        schema: transferSchemas.createTransferSchema,
        handler: transferController.create,
      },
      {
        method: 'GET',
        url: '/',
        summary: 'List transfers',
        description: `List all transfers with filters.

**Query params:**
- \`status\`: Filter by status (draft, approved, dispatched, received, cancelled)
- \`branch\`: Filter by sender or receiver branch
- \`type=challan\`: Alias for listing challans
- \`challanNumber\`: Search by challan number`,
        authRoles: permissions.inventory.transferView,
        schema: transferSchemas.listTransfersSchema,
        handler: transferController.list,
      },
      {
        method: 'GET',
        url: '/stats',
        summary: 'Get transfer statistics',
        authRoles: permissions.inventory.transferView,
        handler: transferController.getStats,
      },
      {
        method: 'GET',
        url: '/export',
        summary: 'Export transfers to CSV',
        description: `Export transfer records for archival purposes.

**Important:** Completed/cancelled transfers older than 2 years are automatically deleted by TTL.
Export your data regularly to maintain historical records for compliance and auditing.`,
        authRoles: permissions.inventory.transferView,
        handler: transferController.exportTransfers,
      },
      {
        method: 'GET',
        url: '/:id',
        summary: 'Get transfer details',
        description: 'Get by ID or challan number (e.g., CHN-202512-0001)',
        authRoles: permissions.inventory.transferView,
        schema: transferSchemas.getTransferSchema,
        handler: async (req, reply) => {
          const { id } = req.params;
          if (id.startsWith('CHN-') || id.match(/^[A-Z]{3}-\d{6}-\d+$/i)) {
            return transferController.getByChallanNumber(req, reply);
          }
          return transferController.getById(req, reply);
        },
      },
      {
        method: 'PATCH',
        url: '/:id',
        summary: 'Update transfer',
        description: 'Update items, remarks, or transport details. Only draft transfers can be updated.',
        authRoles: permissions.inventory.transferCreate,
        schema: transferSchemas.updateTransferSchema,
        handler: transferController.update,
      },
    ], { tag: 'Inventory - Transfers', basePath: '/api/v1/inventory/transfers' });
  }, { prefix: '/transfers' });

  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================
  fastify.register(async (instance) => {
    createRoutes(instance, [
      {
        method: 'POST',
        url: '/',
        summary: 'Create stock request',
        description: 'Sub-branch requests stock from head office.',
        authRoles: permissions.inventory.stockRequestCreate,
        schema: stockRequestSchemas.createRequestSchema,
        handler: stockRequestController.create,
      },
      {
        method: 'GET',
        url: '/',
        summary: 'List stock requests',
        description: `List stock requests with filters.

**Query params:**
- \`status=pending\`: Show pending requests
- \`status=approved\`: Show approved requests
- \`priority\`: Filter by priority (low, normal, high, urgent)
- \`branch\`: Filter by requesting branch`,
        authRoles: permissions.inventory.stockRequestView,
        schema: stockRequestSchemas.listRequestsSchema,
        handler: stockRequestController.list,
      },
      {
        method: 'GET',
        url: '/:id',
        summary: 'Get request details',
        authRoles: permissions.inventory.stockRequestView,
        schema: stockRequestSchemas.getRequestSchema,
        handler: stockRequestController.getById,
      },
    ], { tag: 'Inventory - Stock Requests', basePath: '/api/v1/inventory/requests' });
  }, { prefix: '/requests' });
}

export default fp(inventoryRoutes, {
  name: 'inventory-routes',
  dependencies: ['register-core-plugins'],
});
