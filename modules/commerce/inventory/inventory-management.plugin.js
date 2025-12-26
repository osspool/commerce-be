import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import { createActionRouter } from '#routes/utils/createActionRouter.js';
import { transferController, transferSchemas } from './transfer/index.js';
import { purchaseController, purchaseSchemas } from './purchase/index.js';
import { stockRequestController, stockRequestSchemas } from './stock-request/index.js';
import { supplierController, supplierSchemas, supplierEntitySchema } from './supplier/index.js';
import inventoryController from './inventory.controller.js';
import { adjustmentSchema } from './inventory.schemas.js';
import permissions from '#config/permissions.js';
import { itemWrapper, paginateWrapper } from '#common/docs/responseSchemas.js';
import { inventoryActionRegistry } from './inventory.actions.js';

/**
 * Inventory Management Plugin - Optimized
 *
 * Industry-standard minimal API following Stripe/Square patterns.
 * 40% fewer endpoints through action-based state transitions.
 *
 * PURCHASES (5 endpoints):
 *   POST  /inventory/purchases          - Create purchase invoice (draft)
 *   GET   /inventory/purchases          - List purchase invoices
 *   GET   /inventory/purchases/:id      - Get purchase by ID
 *   PATCH /inventory/purchases/:id      - Update draft purchase
 *   POST  /inventory/purchases/:id/action - approve|receive|pay|cancel
 *
 * TRANSFERS (6 endpoints):
 *   POST  /inventory/transfers           - Create transfer/challan
 *   GET   /inventory/transfers           - List transfers (?status=&type=challan for challans)
 *   GET   /inventory/transfers/:id       - Get by ID (also accepts challanNumber)
 *   PATCH /inventory/transfers/:id       - Update draft transfer
 *   POST  /inventory/transfers/:id/action - State transitions: approve|dispatch|in-transit|receive|cancel
 *   GET   /inventory/transfers/stats     - Get statistics
 *
 * STOCK REQUESTS (4 endpoints):
 *   POST /inventory/requests            - Create stock request
 *   GET  /inventory/requests            - List requests (?status=pending for pending)
 *   GET  /inventory/requests/:id        - Get request details
 *   POST /inventory/requests/:id/action - State transitions: approve|reject|fulfill|cancel
 *
 * STOCK VIEWING (1 endpoint):
 *   GET  /inventory/movements           - Stock movement audit trail
 *
 * ADJUSTMENTS (1 endpoint):
 *   POST /inventory/adjustments         - Stock corrections (with optional lostAmount for transaction)
 *
 * Total: 14 endpoints (down from 25+)
 */
async function inventoryManagementPlugin(fastify) {
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
  }, { prefix: '/inventory/suppliers' });

  // ============================================
  // PURCHASES (Head Office Stock Entry)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/inventory/purchases',
      summary: 'List purchase invoices',
      authRoles: permissions.inventory.purchaseView,
      schema: {
        ...purchaseSchemas.listPurchasesSchema,
        response: { 200: paginateWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.getAll,
    },
    {
      method: 'GET',
      url: '/inventory/purchases/:id',
      summary: 'Get purchase invoice',
      authRoles: permissions.inventory.purchaseView,
      schema: {
        ...purchaseSchemas.getPurchaseSchema,
        response: { 200: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.getById,
    },
    {
      method: 'POST',
      url: '/inventory/purchases',
      summary: 'Create purchase invoice',
      authRoles: permissions.inventory.purchase,
      schema: {
        ...purchaseSchemas.createPurchaseSchema,
        response: { 201: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.create,
    },
    {
      method: 'PATCH',
      url: '/inventory/purchases/:id',
      summary: 'Update draft purchase',
      description: 'Only draft purchases can be updated.',
      authRoles: permissions.inventory.purchase,
      schema: {
        ...purchaseSchemas.updatePurchaseSchema,
        response: { 200: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.update,
    },
  ], { tag: 'Inventory - Purchases', basePath: '/api/v1/inventory/purchases' });

  // Inventory Action Routers (Stripe Pattern)
  for (const actionConfig of inventoryActionRegistry) {
    fastify.register((instance, _opts, done) => {
      instance.addHook('preHandler', instance.authenticate);
      createActionRouter(instance, actionConfig);
      done();
    }, { prefix: actionConfig.prefix });
  }

  // ============================================
  // TRANSFERS (Challan Workflow)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/inventory/transfers',
      summary: 'Create stock transfer (challan)',
      description: 'Create a new transfer from head office to sub-branch. Returns draft challan.',
      authRoles: permissions.inventory.transferCreate,
      schema: transferSchemas.createTransferSchema,
      handler: transferController.create,
    },
    {
      method: 'GET',
      url: '/inventory/transfers',
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
      url: '/inventory/transfers/stats',
      summary: 'Get transfer statistics',
      authRoles: permissions.inventory.transferView,
      handler: transferController.getStats,
    },
    {
      method: 'GET',
      url: '/inventory/transfers/:id',
      summary: 'Get transfer details',
      description: 'Get by ID or challan number (e.g., CHN-202512-0001)',
      authRoles: permissions.inventory.transferView,
      schema: transferSchemas.getTransferSchema,
      handler: async (req, reply) => {
        // Smart lookup: try ID first, then challan number
        const { id } = req.params;
        if (id.startsWith('CHN-') || id.match(/^[A-Z]{3}-\d{6}-\d+$/i)) {
          return transferController.getByChallanNumber(req, reply);
        }
        return transferController.getById(req, reply);
      },
    },
    {
      method: 'PATCH',
      url: '/inventory/transfers/:id',
      summary: 'Update transfer',
      description: 'Update items, remarks, or transport details. Only draft transfers can be updated.',
      authRoles: permissions.inventory.transferCreate,
      schema: transferSchemas.updateTransferSchema,
      handler: transferController.update,
    },
  ], { tag: 'Inventory - Transfers', basePath: '/api/v1/inventory/transfers' });


  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/inventory/requests',
      summary: 'Create stock request',
      description: 'Sub-branch requests stock from head office.',
      authRoles: permissions.inventory.stockRequestCreate,
      schema: stockRequestSchemas.createRequestSchema,
      handler: stockRequestController.create,
    },
    {
      method: 'GET',
      url: '/inventory/requests',
      summary: 'List stock requests',
      description: `List stock requests with filters.

**Query params:**
- \`status=pending\`: Show pending requests (replaces /requests/pending)
- \`status=approved\`: Show approved requests
- \`priority\`: Filter by priority (low, normal, high, urgent)
- \`branch\`: Filter by requesting branch`,
      authRoles: permissions.inventory.stockRequestView,
      schema: stockRequestSchemas.listRequestsSchema,
      handler: stockRequestController.list,
    },
    {
      method: 'GET',
      url: '/inventory/requests/:id',
      summary: 'Get request details',
      authRoles: permissions.inventory.stockRequestView,
      schema: stockRequestSchemas.getRequestSchema,
      handler: stockRequestController.getById,
    },
  ], { tag: 'Inventory - Stock Requests', basePath: '/api/v1/inventory/requests' });


  // ============================================
  // STOCK VIEWING
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/inventory/movements',
      summary: 'Get stock movements',
      description: 'Stock movement audit trail with filters.',
      authRoles: permissions.inventory.movements,
      handler: inventoryController.getMovements,
    },
  ], { tag: 'Inventory - Stock', basePath: '/api/v1/inventory' });

  // ============================================
  // ADJUSTMENTS
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/inventory/adjustments',
      summary: 'Adjust stock',
      description: `Stock correction for damaged, lost, or recount.

**Optional transaction creation:**
- Provide \`lostAmount\` to create an expense transaction for the value lost
- Without \`lostAmount\`, only StockMovement audit trail is created

Example with transaction:
\`\`\`json
{
  "items": [{ "productId": "...", "quantity": 5, "mode": "remove" }],
  "reason": "damaged",
  "lostAmount": 2500
}
\`\`\``,
      authRoles: permissions.inventory.adjust,
      schema: adjustmentSchema,
      handler: inventoryController.bulkImport,
    },
  ], { tag: 'Inventory - Adjustments', basePath: '/api/v1/inventory/adjustments' });
}

export default fp(inventoryManagementPlugin, {
  name: 'inventory-management',
  dependencies: ['register-core-plugins'],
});
