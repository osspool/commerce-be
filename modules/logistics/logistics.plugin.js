import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import logisticsController from './logistics.controller.js';
import logisticsService from './services/logistics.service.js';
import {
  getDivisionsSchema,
  getDistrictsSchema,
  getAreasSchema,
  searchAreasSchema,
  getZonesSchema,
  estimateChargeSchema,
  calculateChargeSchema,
  getConfigSchema,
  createShipmentSchema,
  getShipmentSchema,
  trackShipmentSchema,
  updateShipmentStatusSchema,
  cancelShipmentSchema,
  getPickupStoresSchema,
  webhookSchema,
  circuitStatusSchema,
  resetCircuitSchema,
} from './logistics.schemas.js';

/**
 * Logistics Plugin
 *
 * Registers logistics routes for shipment and area management.
 * Uses createRoutes for consistent route registration and auto-documentation.
 */
async function logisticsPlugin(fastify) {
  // Initialize logistics service on startup
  fastify.addHook('onReady', async () => {
    try {
      await logisticsService.initialize();
      fastify.log.info('Logistics service initialized');
    } catch (error) {
      fastify.log.warn('Logistics service initialization skipped:', error.message);
    }
  });

  // ============================================
  // LOCATION ROUTES (Public - for checkout)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/divisions',
      summary: 'Get all divisions (8 divisions of Bangladesh)',
      schema: getDivisionsSchema,
      handler: logisticsController.getDivisions,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/divisions/:division/districts',
      summary: 'Get districts by division',
      schema: getDistrictsSchema,
      handler: logisticsController.getDistricts,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/areas',
      summary: 'Get all delivery areas',
      schema: getAreasSchema,
      handler: logisticsController.getAreas,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/areas/search',
      summary: 'Search areas by name or post code',
      schema: searchAreasSchema,
      handler: logisticsController.searchAreas,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/zones',
      summary: 'Get delivery zones with pricing info',
      schema: getZonesSchema,
      handler: logisticsController.getDeliveryZones,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/locations/estimate',
      summary: 'Estimate delivery charge (static calculation)',
      schema: estimateChargeSchema,
      handler: logisticsController.estimateCharge,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });

  // ============================================
  // CHARGE CALCULATION (Public)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/logistics/charge',
      summary: 'Calculate charge via provider API',
      description: 'Fetches real-time pricing from the shipping provider',
      schema: calculateChargeSchema,
      handler: logisticsController.calculateCharge,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });

  // ============================================
  // CONFIG ROUTES (Admin only - Read-only)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/logistics/config',
      summary: 'Get logistics configuration (read-only from .env)',
      description: 'Configuration is managed via environment variables. Restart server after changes to .env file.',
      authRoles: ['admin'],
      schema: getConfigSchema,
      handler: logisticsController.getConfig,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });

  // ============================================
  // SHIPMENT ROUTES
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/api/v1/logistics/shipments',
      summary: 'Create shipment for an order',
      authRoles: ['admin', 'store-manager'],
      schema: createShipmentSchema,
      handler: logisticsController.createShipment,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/shipments/:id',
      summary: 'Get shipment by ID',
      authRoles: ['admin', 'store-manager'],
      schema: getShipmentSchema,
      handler: logisticsController.getShipment,
    },
    {
      method: 'GET',
      url: '/api/v1/logistics/shipments/:id/track',
      summary: 'Track shipment (fetch from provider)',
      authRoles: ['admin', 'store-manager'],
      schema: trackShipmentSchema,
      handler: logisticsController.trackShipment,
    },
    {
      method: 'PATCH',
      url: '/api/v1/logistics/shipments/:id/status',
      summary: 'Update shipment status manually',
      authRoles: ['admin', 'store-manager'],
      schema: updateShipmentStatusSchema,
      handler: logisticsController.updateShipmentStatus,
    },
    {
      method: 'POST',
      url: '/api/v1/logistics/shipments/:id/cancel',
      summary: 'Cancel shipment',
      authRoles: ['admin', 'store-manager'],
      schema: cancelShipmentSchema,
      handler: logisticsController.cancelShipment,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });

  // ============================================
  // PICKUP STORES
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/logistics/pickup-stores',
      summary: 'Get pickup stores from provider',
      authRoles: ['admin', 'store-manager'],
      schema: getPickupStoresSchema,
      handler: logisticsController.getPickupStores,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });

  // ============================================
  // WEBHOOKS (Public, verified by provider)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'POST',
      url: '/api/v1/webhooks/logistics/:provider',
      summary: 'Handle logistics provider webhook',
      description: 'Receives status updates from shipping providers',
      schema: webhookSchema,
      handler: logisticsController.handleWebhook,
    },
  ], { tag: 'Webhooks', basePath: '/api/v1/webhooks' });

  // ============================================
  // HEALTH & MONITORING (Admin only)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/api/v1/logistics/health/circuit-status',
      summary: 'Get circuit breaker status for all providers',
      authRoles: ['admin'],
      schema: circuitStatusSchema,
      handler: logisticsController.getCircuitStatus,
    },
    {
      method: 'POST',
      url: '/api/v1/logistics/health/circuit-reset/:provider',
      summary: 'Reset circuit breaker for a provider',
      authRoles: ['admin'],
      schema: resetCircuitSchema,
      handler: logisticsController.resetProviderCircuit,
    },
  ], { tag: 'Logistics', basePath: '/api/v1/logistics' });
}

export default fp(logisticsPlugin, {
  name: 'logistics',
});
