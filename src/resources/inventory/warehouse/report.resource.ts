/**
 * Inventory Reports Resource (Enterprise)
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Handlers live in report.handlers.ts; pure parsers in report.utils.ts.
 */
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { reportSchemas } from './warehouse-advanced.schemas.js';
import {
  getAgingReport,
  getTurnoverReport,
  getAvailabilityMatrix,
  getHealthMetrics,
} from './report.handlers.js';

export const reportResource = defineResource({
  name: 'inventory-reports',
  displayName: 'Inventory Reports',
  tag: 'Warehouse - Reports',
  prefix: '/inventory/reports',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/aging',
      summary: 'Stock aging report',
      description: 'Aging buckets (default 30/60/90 days) by SKU and location.',
      permissions: permissions.inventory.reportView,
      wrapHandler: false,
      schema: reportSchemas.aging,
      handler: getAgingReport,
    },
    {
      method: 'GET',
      path: '/turnover',
      summary: 'Stock turnover report',
      description: 'Movement velocity and turnover metrics per SKU.',
      permissions: permissions.inventory.reportView,
      wrapHandler: false,
      schema: reportSchemas.turnover,
      handler: getTurnoverReport,
    },
    {
      method: 'GET',
      path: '/availability',
      summary: 'Availability matrix',
      description: 'Stock availability matrix across locations for specified SKUs.',
      permissions: permissions.inventory.reportView,
      wrapHandler: false,
      schema: reportSchemas.availability,
      handler: getAvailabilityMatrix,
    },
    {
      method: 'GET',
      path: '/health',
      summary: 'Stock health metrics',
      description: 'Coverage ratios, dead stock, velocity classification.',
      permissions: permissions.inventory.reportView,
      wrapHandler: false,
      schema: reportSchemas.health,
      handler: getHealthMetrics,
    },
  ],
});

export default reportResource;
