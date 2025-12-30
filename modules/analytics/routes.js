import { createRoutes } from '#core/factories/createRoutes.js';
import permissions from '#config/permissions.js';
import { itemWrapper, messageWrapper } from '#core/docs/responseSchemas.js';
import analyticsController from './analytics.controller.js';
import analyticsSchemas from './analytics.schemas.js';

/**
 * Analytics Plugin
 * Ecommerce dashboard analytics (single-tenant)
 * 
 * Provides:
 * - Customer stats (total, today)
 * - Order stats (total, by status, today)
 * - Revenue stats (total, today, period breakdown)
 * - Payment method breakdown
 * - Average order value
 */
async function analyticsPlugin(fastify) {
  // Define analytics routes (full paths - basePath is for OpenAPI docs only)
  const routes = [
    {
      method: 'GET',
      url: '/analytics/dashboard',
      summary: 'Get ecommerce dashboard analytics',
      description: 'Comprehensive analytics including customer stats, orders, revenue, and trends',
      authRoles: permissions.analytics.overview,
      schema: {
        querystring: analyticsSchemas.dashboardQuery,
        response: {
          200: itemWrapper(),
          400: messageWrapper(),
          403: messageWrapper(),
        },
      },
      handler: analyticsController.getDashboard.bind(analyticsController),
    },
  ];

  // Register routes (basePath is for OpenAPI docs only, not route prefix)
  createRoutes(fastify, routes, {
    tag: 'Analytics',
    basePath: '/analytics',
  });
}

export default analyticsPlugin;
