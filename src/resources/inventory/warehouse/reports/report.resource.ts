/**
 * Inventory Reports Resource.
 *
 * Mode gates applied per-route (not at resource level) because the
 * report surface mixes tiers:
 *   - aging / turnover / availability / health → enterprise
 *   - valuation / cogs                         → standard+
 */
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { enterpriseModeGuard, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import {
  getAgingReport,
  getAvailabilityMatrix,
  getCogsReport,
  getHealthMetrics,
  getTurnoverReport,
  getValuationReport,
} from './report.handlers.js';
import { reportSchemas } from './report.schemas.js';

const enterprisePreHandlers = [enterpriseModeGuard.preHandler, flowCtxGuard.preHandler];
const standardPreHandlers = [standardModeGuard.preHandler, flowCtxGuard.preHandler];

const reportResource = defineResource({
  name: 'inventory-reports',
  displayName: 'Inventory Reports',
  tag: 'Warehouse - Reports',
  prefix: '/inventory/reports',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/aging',
      summary: 'Stock aging report',
      description: 'Aging buckets (default 30/60/90 days) by SKU and location.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: enterprisePreHandlers,
      schema: reportSchemas.aging,
      handler: getAgingReport,
    },
    {
      method: 'GET',
      path: '/valuation',
      summary: 'Stock valuation report',
      description:
        'Current inventory valuation grouped by location and SKU. Supports snapshot (quant-based, fast) and layers (cost-layer-based, audit-grade) modes.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: standardPreHandlers,
      schema: reportSchemas.valuation,
      handler: getValuationReport,
    },
    {
      method: 'GET',
      path: '/cogs',
      summary: 'Cost of goods sold report',
      description:
        'COGS computed from completed move lines within a date range. Uses cost layer audit trail for penny-accurate costing.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: standardPreHandlers,
      schema: reportSchemas.cogs,
      handler: getCogsReport,
    },
    {
      method: 'GET',
      path: '/turnover',
      summary: 'Stock turnover report',
      description: 'Movement velocity and turnover metrics per SKU.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: enterprisePreHandlers,
      schema: reportSchemas.turnover,
      handler: getTurnoverReport,
    },
    {
      method: 'GET',
      path: '/availability',
      summary: 'Availability matrix',
      description: 'Stock availability matrix across locations for specified SKUs.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: enterprisePreHandlers,
      schema: reportSchemas.availability,
      handler: getAvailabilityMatrix,
    },
    {
      method: 'GET',
      path: '/health',
      summary: 'Stock health metrics',
      description: 'Coverage ratios, dead stock, velocity classification.',
      permissions: permissions.inventory.reportView,
      raw: true,
      preHandler: enterprisePreHandlers,
      schema: reportSchemas.health,
      handler: getHealthMetrics,
    },
  ],
});

export default reportResource;
