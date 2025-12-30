import fp from 'fastify-plugin';
import { createRoutes } from '#core/factories/createRoutes.js';
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
  trackShipmentSchema,
  cancelShipmentSchema,
  getPickupStoresSchema,
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
      url: '/locations/divisions',
      summary: 'Get all divisions (8 divisions of Bangladesh)',
      schema: getDivisionsSchema,
      handler: logisticsController.getDivisions,
    },
    {
      method: 'GET',
      url: '/locations/divisions/:division/districts',
      summary: 'Get districts by division',
      schema: getDistrictsSchema,
      handler: logisticsController.getDistricts,
    },
    {
      method: 'GET',
      url: '/locations/areas',
      summary: 'Get all delivery areas',
      schema: getAreasSchema,
      handler: logisticsController.getAreas,
    },
    {
      method: 'GET',
      url: '/locations/areas/search',
      summary: 'Search areas by name or post code',
      schema: searchAreasSchema,
      handler: logisticsController.searchAreas,
    },
    {
      method: 'GET',
      url: '/locations/zones',
      summary: 'Get delivery zones with pricing info',
      schema: getZonesSchema,
      handler: logisticsController.getDeliveryZones,
    },
    {
      method: 'GET',
      url: '/locations/estimate',
      summary: 'Estimate delivery charge (static calculation)',
      schema: estimateChargeSchema,
      handler: logisticsController.estimateCharge,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });

  // ============================================
  // CHARGE CALCULATION (Public)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/charge',
      summary: 'Calculate charge via provider API',
      description: 'Fetches real-time pricing from the shipping provider',
      schema: calculateChargeSchema,
      handler: logisticsController.calculateCharge,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });

  // ============================================
  // CONFIG ROUTES (Admin only - Read-only)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/config',
      summary: 'Get logistics configuration (read-only from .env)',
      description: 'Configuration is managed via environment variables. Restart server after changes to .env file.',
      authRoles: ['admin'],
      schema: getConfigSchema,
      handler: logisticsController.getConfig,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });

  // ============================================
  // SHIPMENT UTILITIES
  // Note: Create/Update shipping via POST/PATCH /orders/:id/shipping
  // These are helper endpoints for provider API operations
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/shipments/:id/track',
      summary: 'Track shipment via provider API',
      description: 'Fetches live tracking info from the shipping provider. Use order ID or tracking number.',
      authRoles: ['admin', 'store-manager'],
      schema: trackShipmentSchema,
      handler: logisticsController.trackShipment,
    },
    {
      method: 'POST',
      url: '/shipments/:id/cancel',
      summary: 'Cancel shipment via provider API',
      description: 'Cancels the shipment in the provider system. Use order ID or tracking number.',
      authRoles: ['admin', 'store-manager'],
      schema: cancelShipmentSchema,
      handler: logisticsController.cancelShipment,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });

  // ============================================
  // PICKUP STORES
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/pickup-stores',
      summary: 'Get pickup stores from provider',
      authRoles: ['admin', 'store-manager'],
      schema: getPickupStoresSchema,
      handler: logisticsController.getPickupStores,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });

  // ============================================
  // HEALTH & MONITORING (Admin only)
  // ============================================
  createRoutes(fastify, [
    {
      method: 'GET',
      url: '/health/circuit-status',
      summary: 'Get circuit breaker status for all providers',
      authRoles: ['admin'],
      schema: circuitStatusSchema,
      handler: logisticsController.getCircuitStatus,
    },
    {
      method: 'POST',
      url: '/health/circuit-reset/:provider',
      summary: 'Reset circuit breaker for a provider',
      authRoles: ['admin'],
      schema: resetCircuitSchema,
      handler: logisticsController.resetProviderCircuit,
    },
  ], { tag: 'Logistics', basePath: '/logistics' });
}

export default fp(logisticsPlugin, {
  name: 'logistics',
});
