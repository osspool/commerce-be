import type { FastifyRequest, FastifyReply } from 'fastify';
import logisticsService from './services/logistics.service.js';
import config from '../../config/index.js';
import Order from '#resources/sales/orders/order.model.js';
import { getSupportedProviders, getAllCircuitStatuses, resetCircuit } from '@classytic/bd-logistics';
import bdAreas from '@classytic/bd-areas';
import { DELIVERY_ZONES, estimateDeliveryCharge } from './utils/zones.js';

interface ProviderConfig {
  apiUrl: string;
  apiKey: string;
  isSandbox: boolean;
}

/**
 * Logistics Controller
 *
 * HTTP handlers for logistics operations.
 * Shipment data is stored in Order.shipping (consolidated model).
 * Configuration is managed via .env (config/sections/logistics.config.js)
 */
class LogisticsController {
  constructor() {
    // Bind methods
    this.getConfig = this.getConfig.bind(this);
    this.getAreas = this.getAreas.bind(this);
    this.searchAreas = this.searchAreas.bind(this);
    this.getDivisions = this.getDivisions.bind(this);
    this.getDistricts = this.getDistricts.bind(this);
    this.getDeliveryZones = this.getDeliveryZones.bind(this);
    this.estimateCharge = this.estimateCharge.bind(this);
    this.trackShipment = this.trackShipment.bind(this);
    this.cancelShipment = this.cancelShipment.bind(this);
    this.getPickupStores = this.getPickupStores.bind(this);
    this.calculateCharge = this.calculateCharge.bind(this);
    this.handleWebhook = this.handleWebhook.bind(this);
    this.getCircuitStatus = this.getCircuitStatus.bind(this);
    this.resetProviderCircuit = this.resetProviderCircuit.bind(this);
  }

  // ============================================
  // CONFIG
  // ============================================

  async getConfig(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const logisticsConfig = config.logistics;

    const providers = Object.entries(logisticsConfig.providers as Record<string, ProviderConfig>)
      .filter(([_, providerConfig]) => providerConfig.apiKey)
      .map(([name, providerConfig]) => ({
        provider: name,
        apiUrl: providerConfig.apiUrl,
        apiKey: providerConfig.apiKey ? `${providerConfig.apiKey.slice(0, 20)}...` : null,
        isSandbox: providerConfig.isSandbox,
        isActive: true,
        isDefault: name === logisticsConfig.defaultProvider,
      }));

    return reply.send({
      success: true,
      data: {
        defaultProvider: logisticsConfig.defaultProvider,
        providers,
        supportedProviders: getSupportedProviders(),
        note: 'Configuration is managed via .env file. Restart server after changes.',
      },
    });
  }

  // ============================================
  // AREAS (Static Constants)
  // ============================================

  async getAreas(
    req: FastifyRequest<{ Querystring: { zoneId?: string; district?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { zoneId, district } = req.query;

    let areas = bdAreas.getAllAreas();

    if (zoneId) {
      areas = areas.filter((a) => a.zoneId === parseInt(zoneId, 10));
    }
    if (district) {
      areas = areas.filter((a) => a.districtId === district);
    }

    return reply.send({
      success: true,
      data: areas,
    });
  }

  async searchAreas(
    req: FastifyRequest<{ Querystring: { q: string; limit?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { q, limit } = req.query;

    if (!q || q.length < 2) {
      return reply.code(400).send({
        success: false,
        message: 'Search query must be at least 2 characters',
      });
    }

    const areas = bdAreas.searchAreas(q, parseInt(limit as string, 10) || 20);

    return reply.send({
      success: true,
      data: areas,
    });
  }

  async getDivisions(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    return reply.send({
      success: true,
      data: bdAreas.getDivisions(),
    });
  }

  async getDistricts(req: FastifyRequest<{ Params: { division: string } }>, reply: FastifyReply): Promise<void> {
    const { division } = req.params;

    const districts = bdAreas.getDistrictsByDivision(division);

    if (!districts.length) {
      return reply.code(404).send({
        success: false,
        message: `Division '${division}' not found`,
      });
    }

    return reply.send({
      success: true,
      data: districts,
    });
  }

  async getDeliveryZones(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    return reply.send({
      success: true,
      data: DELIVERY_ZONES,
    });
  }

  async estimateCharge(
    req: FastifyRequest<{ Querystring: { areaId: string; amount?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { areaId, amount } = req.query;

    if (!areaId) {
      return reply.code(400).send({
        success: false,
        message: 'areaId is required',
      });
    }

    const area = bdAreas.getArea(parseInt(areaId, 10));
    if (!area) {
      return reply.code(404).send({
        success: false,
        message: 'Area not found',
      });
    }

    const estimate = estimateDeliveryCharge(area.zoneId, parseFloat(amount as string) || 0);

    return reply.send({
      success: true,
      data: {
        area,
        ...estimate,
      },
    });
  }

  // ============================================
  // SHIPMENT UTILITIES
  // ============================================

  async trackShipment(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    const { id } = req.params;

    let order = await Order.findById(id);
    if (!order) {
      order = await logisticsService.findOrderByTrackingNumber(id);
    }

    if (!order?.shipping?.trackingNumber) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    try {
      const result = await logisticsService.trackShipment(order.shipping.trackingNumber);

      return reply.send({
        success: true,
        data: {
          orderId: result.order._id,
          shipping: result.order.shipping,
          tracking: result.tracking,
        },
      });
    } catch (error) {
      const err = error as Error;
      return reply.code(400).send({
        success: false,
        message: err.message,
      });
    }
  }

  async cancelShipment(
    req: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = req.params;
    const { reason } = req.body;

    let order = await Order.findById(id);
    if (!order) {
      order = await logisticsService.findOrderByTrackingNumber(id);
    }

    if (!order?.shipping?.trackingNumber) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    try {
      const result = await logisticsService.cancelShipment(
        order.shipping.trackingNumber,
        reason || 'Cancelled by merchant',
        (req as unknown as { user?: { _id?: string } }).user?._id,
      );

      return reply.send({
        success: true,
        data: {
          orderId: result.order._id,
          shipping: result.order.shipping,
        },
        message: result.message,
      });
    } catch (error) {
      const err = error as Error;
      return reply.code(400).send({
        success: false,
        message: err.message,
      });
    }
  }

  // ============================================
  // PICKUP STORES
  // ============================================

  async getPickupStores(
    req: FastifyRequest<{ Querystring: { provider?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { provider } = req.query;

    try {
      const stores = await logisticsService.getPickupStores(provider);

      return reply.send({
        success: true,
        data: stores,
      });
    } catch (error) {
      const err = error as Error;
      return reply.code(400).send({
        success: false,
        message: err.message,
      });
    }
  }

  // ============================================
  // CHARGE CALCULATION
  // ============================================

  async calculateCharge(
    req: FastifyRequest<{
      Querystring: {
        deliveryAreaId: string;
        pickupAreaId?: string;
        amount: string;
        weight?: string;
        provider?: string;
      };
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { deliveryAreaId, pickupAreaId, amount, weight, provider } = req.query;

    if (!deliveryAreaId || amount === undefined) {
      return reply.code(400).send({
        success: false,
        message: 'deliveryAreaId and amount are required',
      });
    }

    try {
      let resolvedPickupAreaId = pickupAreaId;
      if (!resolvedPickupAreaId) {
        const pickupStores = await logisticsService.getPickupStores(provider);
        if (pickupStores && pickupStores.length > 0) {
          resolvedPickupAreaId = (pickupStores[0] as Record<string, unknown>).areaId as string;
        }
      }

      if (!resolvedPickupAreaId) {
        return reply.code(400).send({
          success: false,
          message: 'No pickup store configured. Please create a pickup store in your RedX dashboard.',
        });
      }

      const chargeParams = {
        deliveryAreaId: parseInt(deliveryAreaId, 10),
        pickupAreaId: parseInt(resolvedPickupAreaId, 10),
        cashCollectionAmount: parseFloat(amount),
        weight: parseInt(weight as string, 10) || 500,
      };

      const charges = await logisticsService.calculateCharge(chargeParams, provider);

      return reply.send({
        success: true,
        data: charges,
      });
    } catch (error) {
      const err = error as Error;
      return reply.code(400).send({
        success: false,
        message: err.message,
      });
    }
  }

  // ============================================
  // WEBHOOKS
  // ============================================

  async handleWebhook(req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply): Promise<void> {
    const { provider } = req.params;

    try {
      const order = await logisticsService.processWebhook(provider, req.body);

      if (order) {
        req.server.log.info(`Webhook processed for order ${order._id}: ${order.shipping.status}`);
      }

      return reply.send({ success: true });
    } catch (error) {
      const err = error as Error;
      req.server.log.error({ err }, 'Webhook processing error');
      return reply.code(400).send({
        success: false,
        message: err.message,
      });
    }
  }

  // ============================================
  // HEALTH & MONITORING
  // ============================================

  async getCircuitStatus(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const allStatuses = getAllCircuitStatuses();

    return reply.send({
      success: true,
      data: allStatuses,
    });
  }

  async resetProviderCircuit(
    req: FastifyRequest<{ Params: { provider: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { provider } = req.params;

    resetCircuit(provider);

    return reply.send({
      success: true,
      message: `Circuit breaker for ${provider} has been reset`,
    });
  }
}

export default new LogisticsController();
