/**
 * Purchase Routes
 *
 * Routes for purchase invoice management.
 * Uses action-based pattern for state transitions.
 */

import fp from 'fastify-plugin';
import { createRoutes } from '#core/factories/createRoutes.js';
import purchaseController from './purchase.controller.js';
import * as purchaseSchemas from './purchase.schemas.js';
import permissions from '#config/permissions.js';
import { paginateWrapper, itemWrapper } from '#core/docs/responseSchemas.js';

async function purchaseRoutes(fastify) {
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/',
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
      url: '/:id',
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
      url: '/',
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
      url: '/:id',
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
}

export default fp(purchaseRoutes, {
  name: 'purchase-routes',
});
