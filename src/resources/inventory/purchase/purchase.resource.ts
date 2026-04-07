/**
 * Purchase Resource Definition
 *
 * Uses disableDefaultRoutes + wrapHandler: true so Arc's sendControllerResponse
 * handles response flattening (docs pagination, item wrapping) consistently
 * with default CRUD routes.
 */
import { defineResource } from '@classytic/arc';
import { paginateWrapper, itemWrapper } from '@classytic/arc/utils';
import permissions from '#config/permissions.js';
import { purchaseController, purchaseSchemas } from './index.js';

const ctrl = purchaseController;

const purchaseResource = defineResource({
  name: 'purchase',
  audit: true,
  displayName: 'Purchases',
  tag: 'Inventory - Purchases',
  prefix: '/inventory/purchases',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List purchase invoices',
      permissions: permissions.inventory.purchaseView,
      wrapHandler: true,
      schema: {
        ...purchaseSchemas.listPurchasesSchema,
        response: {
          200: paginateWrapper(purchaseSchemas.purchaseEntitySchema as { type: string; [key: string]: unknown }),
        },
      },
      handler: ctrl.list.bind(ctrl),
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get purchase invoice',
      permissions: permissions.inventory.purchaseView,
      wrapHandler: true,
      schema: {
        ...purchaseSchemas.getPurchaseSchema,
        response: {
          200: itemWrapper(purchaseSchemas.purchaseEntitySchema as { type: string; [key: string]: unknown }),
        },
      },
      handler: ctrl.get.bind(ctrl),
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create purchase invoice',
      permissions: permissions.inventory.purchase,
      wrapHandler: true,
      schema: {
        ...purchaseSchemas.createPurchaseSchema,
        response: {
          201: itemWrapper(purchaseSchemas.purchaseEntitySchema as { type: string; [key: string]: unknown }),
        },
      },
      handler: ctrl.create.bind(ctrl),
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update draft purchase',
      permissions: permissions.inventory.purchase,
      wrapHandler: true,
      schema: {
        ...purchaseSchemas.updatePurchaseSchema,
        response: {
          200: itemWrapper(purchaseSchemas.purchaseEntitySchema as { type: string; [key: string]: unknown }),
        },
      },
      handler: ctrl.update.bind(ctrl),
    },
  ],
});

export default purchaseResource;
