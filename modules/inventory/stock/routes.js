/**
 * Stock Routes
 *
 * Custom routes for stock operations (not standard CRUD).
 * Stock operations are action-based: lookup, adjust, view movements.
 */

import fp from 'fastify-plugin';
import { createRoutes } from '#core/factories/createRoutes.js';
import stockController from './stock.controller.js';
import { adjustmentSchema } from './stock.schemas.js';
import permissions from '#config/permissions.js';

async function stockRoutes(fastify) {
  // ============================================
  // STOCK VIEWING & EXPORT
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/movements',
      summary: 'Get stock movements',
      description: 'Stock movement audit trail with filters.',
      authRoles: permissions.inventory.movements,
      handler: stockController.getMovements,
    },
    {
      method: 'GET',
      url: '/movements/export',
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
      authRoles: permissions.inventory.movements,
      handler: stockController.exportMovements,
    },
  ], { tag: 'Inventory - Stock', basePath: '/api/v1/inventory' });

  // ============================================
  // ADJUSTMENTS
  // ============================================
  fastify.register(async (instance) => {
    createRoutes(instance, [
      {
        method: 'POST',
        url: '/',
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
        handler: stockController.bulkImport,
      },
    ], { tag: 'Inventory - Adjustments', basePath: '/api/v1/inventory/adjustments' });
  }, { prefix: '/adjustments' });
}

export default fp(stockRoutes, {
  name: 'stock-routes',
});
