import { defineResource } from '@classytic/arc';
import { allowPublic } from '@classytic/arc/permissions';
import { logisticsActions } from '#shared/permissions.js';
import logisticsController from './logistics.controller.js';

const ctrl = logisticsController as Record<string, any>;

const logisticsResource = defineResource({
  name: 'logistics',
  displayName: 'Logistics',
  tag: 'Logistics',
  prefix: '/logistics',

  // No own model — this resource wraps the carrier registry + bd-areas
  // dataset. Routes are all custom (search, charge, webhook, csv).
  disableDefaultRoutes: true,

  routes: [
    // ── Config ──
    {
      method: 'GET',
      path: '/config',
      summary: 'Get logistics configuration (read-only)',
      permissions: logisticsActions.admin,
      raw: true,
      handler: ctrl.getConfig,
    },

    // ── Unified bd-areas dataset (RedX-aligned) ──
    {
      method: 'GET',
      path: '/locations/divisions',
      summary: 'List all 8 BD divisions',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getDivisions,
    },
    {
      method: 'GET',
      path: '/locations/divisions/:division/districts',
      summary: 'List districts in a division',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getDistricts,
    },
    {
      method: 'GET',
      path: '/locations/areas',
      summary: 'List all delivery areas (filterable by zoneId / district)',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getAreas,
    },
    {
      method: 'GET',
      path: '/locations/areas/search',
      summary: 'Search areas by name or post code',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.searchAreas,
    },
    {
      method: 'GET',
      path: '/locations/areas/by-postcode',
      summary: 'List areas matching a postal code',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getAreasByPostCode,
    },
    {
      method: 'GET',
      path: '/locations/zones',
      summary: 'Get internal delivery zones with pricing tiers',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getDeliveryZones,
    },
    {
      method: 'GET',
      path: '/locations/estimate',
      summary: 'Static charge estimate for an area + amount',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.estimateCharge,
    },

    // ── Pathao native taxonomy (cities + zones) ──
    {
      method: 'GET',
      path: '/locations/pathao/cities',
      summary: 'List Pathao cities (canonical names + IDs)',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getPathaoCities,
    },
    {
      method: 'GET',
      path: '/locations/pathao/cities/:cityId/zones',
      summary: 'List Pathao zones inside a city',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.getPathaoZones,
    },
    {
      method: 'GET',
      path: '/locations/pathao/search',
      summary: 'Search Pathao zones across cities by name',
      permissions: logisticsActions.public,
      raw: true,
      handler: ctrl.searchPathaoZones,
    },

    // ── Quote / shipment lifecycle ──
    {
      method: 'POST',
      path: '/quote',
      summary: 'Get rate quotes from a carrier',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.quoteShipment,
    },
    {
      method: 'POST',
      path: '/shipments',
      summary: 'Create a carrier shipment for a fulfillment',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.createShipment,
    },
    {
      method: 'GET',
      path: '/shipments/:id/track',
      summary: 'Track a shipment by carrier tracking number',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.trackShipment,
    },
    {
      method: 'POST',
      path: '/shipments/:id/cancel',
      summary: 'Cancel a shipment via the carrier',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.cancelShipment,
    },

    // ── Carrier-side queries ──
    {
      method: 'GET',
      path: '/pickup-stores',
      summary: 'List pickup stores from a carrier',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.getPickupStores,
    },

    // ── Bulk export (Pathao CSV) ──
    {
      method: 'GET',
      path: '/export/pathao-csv',
      summary: 'Stream a Pathao bulk-upload CSV for filtered orders',
      description: 'Same query semantics as GET /orders. Caps at 500 rows per call. Upload at merchant.pathao.com.',
      permissions: logisticsActions.manage,
      raw: true,
      handler: ctrl.exportPathaoCsv,
    },

    // ── Webhooks ──
    {
      method: 'POST',
      path: '/webhooks/:provider',
      summary: 'Carrier webhook ingestion (RedX / Pathao / Steadfast)',
      permissions: allowPublic(),
      raw: true,
      handler: ctrl.handleWebhook,
    },
  ],
});

export default logisticsResource;
