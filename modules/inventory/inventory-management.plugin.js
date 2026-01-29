import fp from 'fastify-plugin';
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { createActionRouter } from '@classytic/arc/core';
import { transferController, transferSchemas } from './transfer/index.js';
import { purchaseController, purchaseSchemas } from './purchase/index.js';
import { stockRequestController, stockRequestSchemas } from './stock-request/index.js';
import { Supplier, supplierController, supplierRepository, supplierSchemas, supplierEntitySchema, supplierSchemaOptions } from './supplier/index.js';
import inventoryController from './inventory.controller.js';
import { adjustmentSchema } from './inventory.schemas.js';
import permissions from '#config/permissions.js';
import { itemWrapper, paginateWrapper } from '@classytic/arc/utils';
import { inventoryActionRegistry } from './inventory.actions.js';

const supplierResource = defineResource({
  name: 'supplier',
  displayName: 'Suppliers',
  tag: 'Inventory - Suppliers',
  prefix: '/inventory/suppliers',

  adapter: createMongooseAdapter({
    model: Supplier,
    repository: supplierRepository,
  }),
  controller: supplierController,
  schemaOptions: supplierSchemaOptions,
  customSchemas: {
    ...supplierSchemas,
    entity: supplierEntitySchema,
  },

  permissions: {
    list: permissions.inventory.supplierView,
    get: permissions.inventory.supplierView,
    create: permissions.inventory.supplierManage,
    update: permissions.inventory.supplierManage,
    delete: permissions.inventory.supplierManage,
  },
});

const purchaseResource = defineResource({
  name: 'purchase',
  displayName: 'Purchases',
  tag: 'Inventory - Purchases',
  prefix: '/inventory/purchases',

  controller: purchaseController,
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List purchase invoices',
      permissions: permissions.inventory.purchaseView,
      wrapHandler: false,
      schema: {
        ...purchaseSchemas.listPurchasesSchema,
        response: { 200: paginateWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.list.bind(purchaseController),
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get purchase invoice',
      permissions: permissions.inventory.purchaseView,
      wrapHandler: false,
      schema: {
        ...purchaseSchemas.getPurchaseSchema,
        response: { 200: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.get.bind(purchaseController),
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create purchase invoice',
      permissions: permissions.inventory.purchase,
      wrapHandler: false,
      schema: {
        ...purchaseSchemas.createPurchaseSchema,
        response: { 201: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.create.bind(purchaseController),
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update draft purchase',
      description: 'Only draft purchases can be updated.',
      permissions: permissions.inventory.purchase,
      wrapHandler: false,
      schema: {
        ...purchaseSchemas.updatePurchaseSchema,
        response: { 200: itemWrapper(purchaseSchemas.purchaseEntitySchema) },
      },
      handler: purchaseController.update.bind(purchaseController),
    },
  ],
});

const transferResource = defineResource({
  name: 'transfer',
  displayName: 'Transfers',
  tag: 'Inventory - Transfers',
  prefix: '/inventory/transfers',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create stock transfer (challan)',
      description: 'Create a new transfer from head office to sub-branch. Returns draft challan.',
      permissions: permissions.inventory.transferCreate,
      wrapHandler: false,
      schema: transferSchemas.createTransferSchema,
      handler: transferController.create.bind(transferController),
    },
    {
      method: 'GET',
      path: '/',
      summary: 'List transfers',
      description: `List all transfers with filters.

**Query params:**
- \`status\`: Filter by status (draft, approved, dispatched, received, cancelled)
- \`branch\`: Filter by sender or receiver branch
- \`type=challan\`: Alias for listing challans
- \`challanNumber\`: Search by challan number`,
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      schema: transferSchemas.listTransfersSchema,
      handler: transferController.list.bind(transferController),
    },
    {
      method: 'GET',
      path: '/stats',
      summary: 'Get transfer statistics',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      handler: transferController.getStats.bind(transferController),
    },
    {
      method: 'GET',
      path: '/export',
      summary: 'Export transfers to CSV',
      description: `Export transfer records for archival purposes.

**Important:** Completed/cancelled transfers older than 2 years are automatically deleted by TTL.
Export your data regularly to maintain historical records for compliance and auditing.

**Query params:**
- \`status\`: Filter by status
- \`senderBranch\`: Filter by sender branch
- \`receiverBranch\`: Filter by receiver branch
- \`transferType\`: Filter by type
- \`startDate\`/\`endDate\`: Date range
- \`limit\`: Max records (default: 10000, max: 50000)`,
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      handler: transferController.exportTransfers.bind(transferController),
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get transfer details',
      description: 'Get by ID or challan number (e.g., CHN-202512-0001)',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
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
      path: '/:id',
      summary: 'Update transfer',
      description: 'Update items, remarks, or transport details. Only draft transfers can be updated.',
      permissions: permissions.inventory.transferCreate,
      wrapHandler: false,
      schema: transferSchemas.updateTransferSchema,
      handler: transferController.update.bind(transferController),
    },
  ],
});

const stockRequestResource = defineResource({
  name: 'stock-request',
  displayName: 'Stock Requests',
  tag: 'Inventory - Stock Requests',
  prefix: '/inventory/requests',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create stock request',
      description: 'Sub-branch requests stock from head office.',
      permissions: permissions.inventory.stockRequestCreate,
      wrapHandler: false,
      schema: stockRequestSchemas.createRequestSchema,
      handler: stockRequestController.create.bind(stockRequestController),
    },
    {
      method: 'GET',
      path: '/',
      summary: 'List stock requests',
      description: `List stock requests with filters.

**Query params:**
- \`status=pending\`: Show pending requests (replaces /requests/pending)
- \`status=approved\`: Show approved requests
- \`priority\`: Filter by priority (low, normal, high, urgent)
- \`branch\`: Filter by requesting branch`,
      permissions: permissions.inventory.stockRequestView,
      wrapHandler: false,
      schema: stockRequestSchemas.listRequestsSchema,
      handler: stockRequestController.list.bind(stockRequestController),
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get request details',
      permissions: permissions.inventory.stockRequestView,
      wrapHandler: false,
      schema: stockRequestSchemas.getRequestSchema,
      handler: stockRequestController.getById.bind(stockRequestController),
    },
  ],
});

const inventoryOpsResource = defineResource({
  name: 'inventory',
  displayName: 'Inventory',
  tag: 'Inventory',
  prefix: '/inventory',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/movements',
      summary: 'Get stock movements',
      description: 'Stock movement audit trail with filters.',
      permissions: permissions.inventory.movements,
      wrapHandler: false,
      tags: ['Inventory - Stock'],
      handler: inventoryController.getMovements.bind(inventoryController),
    },
    {
      method: 'GET',
      path: '/movements/export',
      summary: 'Export stock movements to CSV',
      description: `Export stock movements for archival purposes.

**Important:** Stock movements older than 2 years are automatically deleted by TTL.
Export your data regularly to maintain historical records for compliance and auditing.

**Query params:**
- \`productId\`: Filter by product
- \`branchId\`: Filter by branch
- \`type\`: Movement type (sale, return, adjustment, etc.)
- \`startDate\`/\`endDate\`: Date range
- \`limit\`: Max records (default: 10000, max: 50000)`,
      permissions: permissions.inventory.movements,
      wrapHandler: false,
      tags: ['Inventory - Stock'],
      handler: inventoryController.exportMovements.bind(inventoryController),
    },
    {
      method: 'POST',
      path: '/adjustments',
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
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: adjustmentSchema,
      tags: ['Inventory - Adjustments'],
      handler: inventoryController.bulkImport.bind(inventoryController),
    },
  ],
});

async function inventoryManagementPlugin(fastify) {
  await fastify.register(supplierResource.toPlugin());
  await fastify.register(purchaseResource.toPlugin());
  await fastify.register(transferResource.toPlugin());
  await fastify.register(stockRequestResource.toPlugin());
  await fastify.register(inventoryOpsResource.toPlugin());

  for (const actionConfig of inventoryActionRegistry) {
    fastify.register((instance, _opts, done) => {
      createActionRouter(instance, actionConfig);
      done();
    }, { prefix: actionConfig.prefix });
  }
}

export default fp(inventoryManagementPlugin, {
  name: 'inventory-management',
  dependencies: ['register-core-plugins'],
});
