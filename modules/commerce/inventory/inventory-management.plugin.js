import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import { createActionRouter } from '#routes/utils/createActionRouter.js';
import { transferController, transferSchemas } from './transfer/index.js';
import { purchaseController, purchaseSchemas } from './purchase/index.js';
import { stockRequestController, stockRequestSchemas } from './stock-request/index.js';
import inventoryController from './inventory.controller.js';
import { adjustmentSchema } from './inventory.schemas.js';
import transferService from './transfer/transfer.service.js';
import stockRequestService from './stock-request/stock-request.service.js';
import permissions from '#config/permissions.js';

/**
 * Inventory Management Plugin - Optimized
 *
 * Industry-standard minimal API following Stripe/Square patterns.
 * 40% fewer endpoints through action-based state transitions.
 *
 * PURCHASES (2 endpoints):
 *   POST /inventory/purchases          - Record purchases (single or batch via items[])
 *   GET  /inventory/purchases/history  - View purchase history
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
 * STOCK VIEWING (2 endpoints):
 *   GET  /inventory/low-stock           - Low stock alerts
 *   GET  /inventory/movements           - Stock movement audit trail
 *
 * ADJUSTMENTS (1 endpoint):
 *   POST /inventory/adjustments         - Stock corrections (with optional lostAmount for transaction)
 *
 * Total: 15 endpoints (down from 25+)
 */
async function inventoryManagementPlugin(fastify) {
  // ============================================
  // PURCHASES (Head Office Stock Entry)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/inventory/purchases',
      summary: 'Record stock purchase',
      description: `Add stock to inventory. Supports single item or batch via items[].

**Optional transaction creation:**
- \`createTransaction: false\` (default) - Only creates StockEntry + StockMovement
- \`createTransaction: true\` - Also creates expense transaction for accounting

Manufacturing/homemade products typically use \`createTransaction: false\` since cost is for profit calculation only.`,
      authRoles: permissions.inventory.purchase,
      schema: purchaseSchemas.recordPurchaseSchema,
      handler: purchaseController.create,
    },
    {
      method: 'GET',
      url: '/inventory/purchases/history',
      summary: 'View purchase history',
      authRoles: permissions.inventory.purchaseView,
      schema: purchaseSchemas.purchaseHistorySchema,
      handler: purchaseController.getHistory,
    },
  ], { tag: 'Inventory - Purchases', basePath: '/api/v1/inventory/purchases' });

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

  // Transfer Action Router (Stripe Pattern)
  // Replaces: /approve, /dispatch, /in-transit, /receive, /cancel
  fastify.register((instance, _opts, done) => {
    // Add authentication for all action routes
    instance.addHook('preHandler', instance.authenticate);

    createActionRouter(instance, {
      tag: 'Inventory - Transfers',
      basePath: '/api/v1/inventory/transfers',
      actions: {
        approve: async (id, _data, req) => {
          return transferService.approveTransfer(id, req.user._id || req.user.id);
        },
        dispatch: async (id, data, req) => {
          return transferService.dispatchTransfer(id, data.transport || data, req.user._id || req.user.id);
        },
        'in-transit': async (id, _data, req) => {
          return transferService.markInTransit(id, req.user._id || req.user.id);
        },
        receive: async (id, data, req) => {
          return transferService.receiveTransfer(id, data.items || [], req.user._id || req.user.id);
        },
        cancel: async (id, data, req) => {
          return transferService.cancelTransfer(id, data.reason, req.user._id || req.user.id);
        },
      },
      actionPermissions: {
        approve: permissions.inventory.transferApprove,
        dispatch: permissions.inventory.transferDispatch,
        'in-transit': permissions.inventory.transferDispatch,
        receive: permissions.inventory.transferReceive,
        cancel: permissions.inventory.transferCancel,
      },
      actionSchemas: {
        dispatch: {
          transport: {
            type: 'object',
            description: 'Transport details (vehicle, driver, etc.)',
            properties: {
              vehicleNumber: { type: 'string' },
              driverName: { type: 'string' },
              driverPhone: { type: 'string' },
              notes: { type: 'string' },
            },
          },
        },
        receive: {
          items: {
            type: 'array',
            description: 'Received items with quantities',
            items: {
              type: 'object',
              properties: {
                itemId: { type: 'string' },
                productId: { type: 'string' },
                variantSku: { type: 'string' },
                quantityReceived: { type: 'number' },
              },
            },
          },
        },
        cancel: {
          reason: { type: 'string', description: 'Cancellation reason' },
        },
      },
    });
    done();
  }, { prefix: '/inventory/transfers' });

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

  // Stock Request Action Router (Stripe Pattern)
  // Replaces: /approve, /reject, /fulfill, /cancel
  fastify.register((instance, _opts, done) => {
    // Add authentication for all action routes
    instance.addHook('preHandler', instance.authenticate);

    createActionRouter(instance, {
      tag: 'Inventory - Stock Requests',
      basePath: '/api/v1/inventory/requests',
      actions: {
        approve: async (id, data, req) => {
          return stockRequestService.approveRequest(
            id,
            data.items || data.approvedItems,
            data.reviewNotes || data.notes,
            req.user._id || req.user.id
          );
        },
        reject: async (id, data, req) => {
          return stockRequestService.rejectRequest(id, data.reason, req.user._id || req.user.id);
        },
        fulfill: async (id, data, req) => {
          return stockRequestService.fulfillRequest(id, data, req.user._id || req.user.id);
        },
        cancel: async (id, data, req) => {
          return stockRequestService.cancelRequest(id, data.reason, req.user._id || req.user.id);
        },
      },
      actionPermissions: {
        approve: permissions.inventory.stockRequestApprove,
        reject: permissions.inventory.stockRequestApprove,
        fulfill: permissions.inventory.stockRequestFulfill,
        cancel: permissions.inventory.stockRequestCancel,
      },
      actionSchemas: {
        approve: {
          items: {
            type: 'array',
            description: 'Items with approved quantities',
            items: {
              type: 'object',
              properties: {
                itemId: { type: 'string' },
                productId: { type: 'string' },
                variantSku: { type: 'string' },
                quantityApproved: { type: 'number' },
              },
            },
          },
          reviewNotes: { type: 'string', description: 'Review notes' },
        },
        reject: {
          reason: { type: 'string', description: 'Rejection reason' },
        },
        cancel: {
          reason: { type: 'string', description: 'Cancellation reason' },
        },
      },
    });
    done();
  }, { prefix: '/inventory/requests' });

  // ============================================
  // STOCK VIEWING
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/inventory/low-stock',
      summary: 'Get low stock alerts',
      description: 'List items below reorder point or custom threshold.',
      authRoles: permissions.inventory.alerts,
      handler: inventoryController.getLowStock,
    },
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
