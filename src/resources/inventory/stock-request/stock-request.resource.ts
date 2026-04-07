/**
 * Stock Request Resource Definition
 */
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { stockRequestController, stockRequestSchemas } from './index.js';

const stockRequestResource = defineResource({
  name: 'stock-request',
  audit: true,
  displayName: 'Stock Requests',
  tag: 'Inventory - Stock Requests',
  prefix: '/inventory/requests',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create stock request',
      permissions: permissions.inventory.stockRequestCreate,
      wrapHandler: false,
      schema: stockRequestSchemas.createRequestSchema,
      handler: stockRequestController.create.bind(stockRequestController),
    },
    {
      method: 'GET',
      path: '/',
      summary: 'List stock requests',
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

export default stockRequestResource;
