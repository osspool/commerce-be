import { defineResource } from '@classytic/arc';
import { analyticsActions } from '#shared/permissions.js';
import analyticsController from './analytics.controller.js';
import analyticsSchemas from './analytics.schemas.js';

/**
 * Analytics Resource - SERVICE PATTERN
 *
 * No database model - aggregates data from multiple sources.
 * This demonstrates Arc's flexibility for service-oriented resources.
 *
 * Pattern: disableDefaultRoutes + routes + controller with custom methods
 */
export default defineResource({
  name: 'analytics',
  displayName: 'Analytics',
  tag: 'Analytics',
  prefix: '/analytics',

  // No adapter - service resource that aggregates from multiple models
  // adapter: undefined,

  controller: analyticsController,

  permissions: {
    list: analyticsActions.overview,
    get: analyticsActions.overview,
  },

  // Service resource - no CRUD, only custom endpoints
  disableDefaultRoutes: true,

  // Custom analytics endpoints
  routes: [
    {
      method: 'GET',
      path: '/dashboard',
      handler: 'getDashboard',
      summary: 'Get ecommerce dashboard analytics',
      description: 'Comprehensive analytics including customer stats, orders, revenue, and trends',
      permissions: analyticsActions.overview,
      raw: true,
      schema: {
        querystring: analyticsSchemas.dashboardQuery,
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          403: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  ],
});
