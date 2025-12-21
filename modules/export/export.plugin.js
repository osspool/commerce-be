import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import permissions from '#config/permissions.js';
import { stringify as csvStringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { canViewCostPrice, filterCostPriceByRole } from '#modules/commerce/product/product.utils.js';
import { filterOrderCostPriceByUser } from '#modules/commerce/order/order.costPrice.utils.js';

/**
 * Repository mapping for MongoKit-based exports
 * Maps collection names to their repository modules
 */
const REPOSITORY_MAP = {
  product: 'commerce/product',
  order: 'commerce/order',
  customer: 'customer',
  transaction: 'transaction',
  stockEntry: 'commerce/inventory',
  stockMovement: 'commerce/inventory', // Uses getMovements method
};

/**
 * Apply role-based field filtering
 * Removes sensitive fields based on user role
 */
function filterSensitiveFields(docs, collection, user) {
  if (!Array.isArray(docs) || docs.length === 0) return docs;

  if (collection === 'product') {
    return filterCostPriceByRole(docs, user);
  }

  if (collection === 'order') {
    return filterOrderCostPriceByUser(docs, user);
  }

  // Inventory exports can expose cost; hide unless user has explicit view permission.
  if ((collection === 'stockEntry' || collection === 'stockMovement') && !canViewCostPrice(user)) {
    return docs.map(doc => {
      if (!doc || typeof doc !== 'object') return doc;
      const next = { ...doc };
      delete next.costPrice;    // StockEntry.costPrice
      delete next.costPerUnit;  // StockMovement.costPerUnit
      return next;
    });
  }

  return docs;
}

async function exportPlugin(fastify, opts) {
  // Custom auth middleware for export permissions
  const auth = async (request, reply) => {
    if (!request.user) return reply.code(401).send({ success: false, message: 'Unauthorized' });
    const roles = Array.isArray(request.user.roles) ? request.user.roles : (request.user.roles ? [request.user.roles] : []);
    const allowed = permissions.export.any || [];
    if (allowed.length && !roles.some((r)=>allowed.includes(r)) && !roles.includes('superadmin')) return reply.code(403).send({ success: false, message: 'Forbidden' });
  };

  /**
   * Fetch data using MongoKit repository with proper field filtering
   */
  const fetchData = async (collection, filter) => {
    const repoPath = REPOSITORY_MAP[collection];
    if (!repoPath) {
      throw new Error(`Export not supported for collection: ${collection}. Supported: ${Object.keys(REPOSITORY_MAP).join(', ')}`);
    }

    const repository = (await import(`#modules/${repoPath}/${collection}.repository.js`)).default;

    // Special handling for stock movements
    if (collection === 'stockMovement') {
      const result = await repository.getMovements(filter, { limit: 10000 });
      return result.docs;
    }

    // Use MongoKit repository with pagination
    const result = await repository.getAll({
      filters: filter,
      limit: 10000, // Max export limit
      sort: '-createdAt',
    }, {
      lean: true,
    });

    return result.docs || [];
  };

  // CSV export handler
  const exportCSV = async (request, reply) => {
    const { collection, select, filter } = request.query || {};
    if (!collection) return reply.code(400).send({ message: 'collection is required' });

    const criteria = filter ? JSON.parse(filter) : {};
    const user = request.user;

    try {
      let docs = await fetchData(collection, criteria);

      // Apply role-based filtering
      docs = filterSensitiveFields(docs, collection, user);

      // Apply field selection if specified
      const fields = select ? select.split(',') : undefined;
      if (fields) {
        docs = docs.map(doc => {
          const filtered = {};
          fields.forEach(f => {
            if (doc[f] !== undefined) filtered[f] = doc[f];
          });
          return filtered;
        });
      }

      if (docs.length === 0) {
        return reply.code(404).send({ message: 'No data to export' });
      }

      const headers = fields || Object.keys(docs[0]);
      const csv = csvStringify(docs, { header: true, columns: headers });

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${collection}.csv"`);
      reply.send(csv);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ message: error.message });
    }
  };

  // XLSX export handler (using exceljs for better security)
  const exportXLSX = async (request, reply) => {
    const { collection, select, filter } = request.query || {};
    if (!collection) return reply.code(400).send({ message: 'collection is required' });

    const criteria = filter ? JSON.parse(filter) : {};
    const user = request.user;

    try {
      let docs = await fetchData(collection, criteria);

      // Apply role-based filtering
      docs = filterSensitiveFields(docs, collection, user);

      // Apply field selection if specified
      const fields = select ? select.split(',') : undefined;
      if (fields) {
        docs = docs.map(doc => {
          const filtered = {};
          fields.forEach(f => {
            if (doc[f] !== undefined) filtered[f] = doc[f];
          });
          return filtered;
        });
      }

      if (docs.length === 0) {
        return reply.code(404).send({ message: 'No data to export' });
      }

      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Sheet1');

      // Add headers and data
      const headers = fields || Object.keys(docs[0]);
      worksheet.columns = headers.map(h => ({ header: h, key: h, width: 15 }));
      worksheet.addRows(docs);

      // Write to buffer
      const buffer = await workbook.xlsx.writeBuffer();

      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${collection}.xlsx"`);
      reply.send(buffer);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ message: error.message });
    }
  };

  // Define export routes
  const routes = [
    {
      method: 'GET',
      url: '/export/csv',
      summary: 'Export data as CSV',
      description: 'Export collection data to CSV format with optional filtering',
      schema: {
        querystring: {
          type: 'object',
          required: ['collection'],
          properties: {
            collection: { type: 'string', description: 'Collection name to export' },
            select: { type: 'string', description: 'Comma-separated field names' },
            filter: { type: 'string', description: 'JSON filter criteria' },
          },
        },
      },
      middlewares: [auth], // Custom auth middleware
      handler: exportCSV,
    },
    {
      method: 'GET',
      url: '/export/xlsx',
      summary: 'Export data as Excel',
      description: 'Export collection data to Excel format with optional filtering',
      schema: {
        querystring: {
          type: 'object',
          required: ['collection'],
          properties: {
            collection: { type: 'string', description: 'Collection name to export' },
            select: { type: 'string', description: 'Comma-separated field names' },
            filter: { type: 'string', description: 'JSON filter criteria' },
          },
        },
      },
      middlewares: [auth], // Custom auth middleware
      handler: exportXLSX,
    },
  ];

  // Register routes using factory
  createRoutes(fastify, routes, {
    tag: 'Export',
    basePath: '/api/v1',
    organizationScoped: false, // Export has custom auth
  });
}

export default fp(exportPlugin, { name: 'export-plugin' });

