import logisticsService from './services/logistics.service.js';
import config from '../../config/index.js';
import Shipment from './models/shipment.model.js';
import { getSupportedProviders, getAllCircuitStatuses, resetCircuit } from '@classytic/bd-logistics';
import bdAreas from '@classytic/bd-areas';
import { DELIVERY_ZONES, estimateDeliveryCharge } from './utils/zones.js';

/**
 * Logistics Controller
 *
 * HTTP handlers for logistics operations.
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
    this.createShipment = this.createShipment.bind(this);
    this.getShipment = this.getShipment.bind(this);
    this.trackShipment = this.trackShipment.bind(this);
    this.cancelShipment = this.cancelShipment.bind(this);
    this.getPickupStores = this.getPickupStores.bind(this);
    this.calculateCharge = this.calculateCharge.bind(this);
    this.updateShipmentStatus = this.updateShipmentStatus.bind(this);
    this.handleWebhook = this.handleWebhook.bind(this);
    this.getCircuitStatus = this.getCircuitStatus.bind(this);
    this.resetProviderCircuit = this.resetProviderCircuit.bind(this);
  }

  // ============================================
  // CONFIG
  // ============================================

  /**
   * Get logistics configuration (read-only from .env)
   * Configuration is managed via environment variables
   */
  async getConfig(req, reply) {
    const logisticsConfig = config.logistics;

    // Build provider list with masked API keys
    const providers = Object.entries(logisticsConfig.providers)
      .filter(([_, providerConfig]) => providerConfig.apiKey) // Only show configured providers
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

  /**
   * Get all delivery areas
   * Public - used in checkout dropdowns
   */
  async getAreas(req, reply) {
    const { zoneId, district } = req.query;

    let areas = bdAreas.getAllAreas();

    if (zoneId) {
      areas = areas.filter(a => a.zoneId === parseInt(zoneId));
    }
    if (district) {
      areas = areas.filter(a => a.districtId === district);
    }

    return reply.send({
      success: true,
      data: areas,
    });
  }

  /**
   * Search areas by name or postCode
   */
  async searchAreas(req, reply) {
    const { q, limit } = req.query;

    if (!q || q.length < 2) {
      return reply.code(400).send({
        success: false,
        message: 'Search query must be at least 2 characters',
      });
    }

    const areas = bdAreas.searchAreas(q, parseInt(limit) || 20);

    return reply.send({
      success: true,
      data: areas,
    });
  }

  /**
   * Get all divisions
   */
  async getDivisions(req, reply) {
    return reply.send({
      success: true,
      data: bdAreas.getDivisions(),
    });
  }

  /**
   * Get districts by division
   */
  async getDistricts(req, reply) {
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

  /**
   * Get delivery zones with pricing
   */
  async getDeliveryZones(req, reply) {
    return reply.send({
      success: true,
      data: DELIVERY_ZONES,
    });
  }

  /**
   * Estimate delivery charge (static calculation)
   * Uses zoneId from area data to calculate charges
   */
  async estimateCharge(req, reply) {
    const { areaId, amount } = req.query;

    if (!areaId) {
      return reply.code(400).send({
        success: false,
        message: 'areaId is required',
      });
    }

    // Use getArea with internalId
    const area = bdAreas.getArea(parseInt(areaId));
    if (!area) {
      return reply.code(404).send({
        success: false,
        message: 'Area not found',
      });
    }

    // Use zoneId for charge estimation
    const estimate = estimateDeliveryCharge(area.zoneId, parseFloat(amount) || 0);

    return reply.send({
      success: true,
      data: {
        area,
        ...estimate,
      },
    });
  }

  // ============================================
  // SHIPMENTS
  // ============================================

  async createShipment(req, reply) {
    const { orderId, ...options } = req.body;

    if (!orderId) {
      return reply.code(400).send({
        success: false,
        message: 'orderId is required',
      });
    }

    try {
      // Get order - import dynamically to avoid circular deps
      const { default: orderRepository } = await import('../commerce/order/order.repository.js');
      const order = await orderRepository.getById(orderId);

      if (!order) {
        return reply.code(404).send({
          success: false,
          message: 'Order not found',
        });
      }

      const shipment = await logisticsService.createShipment(order, {
        ...options,
        userId: req.user?._id,
      });

      // Update order with shipment reference
      await orderRepository.update(orderId, {
        'shipping.trackingNumber': shipment.trackingId,
        'shipping.provider': shipment.provider,
        'shipping.shipmentId': shipment._id,
      });

      return reply.code(201).send({
        success: true,
        data: shipment,
        message: 'Shipment created successfully',
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  async getShipment(req, reply) {
    const { id } = req.params;

    const shipment = await Shipment.findById(id).populate('order', 'customerName totalAmount');

    if (!shipment) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    return reply.send({
      success: true,
      data: shipment,
    });
  }

  async trackShipment(req, reply) {
    const { id } = req.params;

    // Can be shipment ID or tracking ID
    let shipment = await Shipment.findById(id);
    if (!shipment) {
      shipment = await Shipment.findByTrackingId(id);
    }

    if (!shipment) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    try {
      const result = await logisticsService.trackShipment(shipment.trackingId);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  async cancelShipment(req, reply) {
    const { id } = req.params;
    const { reason } = req.body;

    let shipment = await Shipment.findById(id);
    if (!shipment) {
      shipment = await Shipment.findByTrackingId(id);
    }

    if (!shipment) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    try {
      const result = await logisticsService.cancelShipment(
        shipment.trackingId,
        reason || 'Cancelled by merchant',
        req.user?._id
      );

      return reply.send({
        success: true,
        data: result.shipment,
        message: result.message,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // PICKUP STORES
  // ============================================

  /**
   * Get pickup stores from provider
   * Admin uses this to select default pickup store
   */
  async getPickupStores(req, reply) {
    const { provider } = req.query;

    try {
      const stores = await logisticsService.getPickupStores(provider);

      return reply.send({
        success: true,
        data: stores,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // CHARGE CALCULATION
  // ============================================

  /**
   * Calculate charge via provider API
   * Fetches pickup area from provider's pickup stores (admin configures in RedX dashboard)
   *
   * Per RedX API: GET /charge/charge_calculator
   *
   * @query deliveryAreaId - Delivery area internalId from bd-areas (resolved to provider-specific ID)
   * @query pickupAreaId - Pickup area internalId (optional - auto-fetched from provider's pickup store)
   * @query amount - Cash collection amount in BDT (COD amount, 0 for prepaid)
   * @query weight - Parcel weight in grams (default: 500g)
   * @query provider - Specific provider (uses default if not specified)
   */
  async calculateCharge(req, reply) {
    const { deliveryAreaId, pickupAreaId, amount, weight, provider } = req.query;

    if (!deliveryAreaId || amount === undefined) {
      return reply.code(400).send({
        success: false,
        message: 'deliveryAreaId and amount are required',
      });
    }

    try {
      // Resolve pickup area ID:
      // 1. Use provided pickupAreaId if given
      // 2. Otherwise fetch from provider's pickup stores (admin sets this in RedX dashboard)
      let resolvedPickupAreaId = pickupAreaId;
      if (!resolvedPickupAreaId) {
        const pickupStores = await logisticsService.getPickupStores(provider);
        if (pickupStores && pickupStores.length > 0) {
          // Use first pickup store's areaId (merchant's default pickup location from RedX)
          resolvedPickupAreaId = pickupStores[0].areaId;
        }
      }

      if (!resolvedPickupAreaId) {
        return reply.code(400).send({
          success: false,
          message: 'No pickup store configured. Please create a pickup store in your RedX dashboard.',
        });
      }

      // Build charge params matching provider ChargeParams interface
      // RedX API: /charge/charge_calculator?delivery_area_id&pickup_area_id&cash_collection_amount&weight
      const chargeParams = {
        deliveryAreaId: parseInt(deliveryAreaId),
        pickupAreaId: parseInt(resolvedPickupAreaId),
        cashCollectionAmount: parseFloat(amount), // COD amount (0 for prepaid)
        weight: parseInt(weight) || 500, // Weight in grams (default 500g)
      };

      // Note: Dimensions are stored in order.parcel but not used by RedX charge calculation
      // RedX only uses weight for pricing. Dimensions kept for future providers.

      const charges = await logisticsService.calculateCharge(chargeParams, provider);

      return reply.send({
        success: true,
        data: charges,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // MANUAL STATUS UPDATE
  // ============================================

  /**
   * Manually update shipment status
   * Same logic as webhook but triggered by admin
   */
  async updateShipmentStatus(req, reply) {
    const { id } = req.params;
    const { status, message, messageLocal } = req.body;

    if (!status) {
      return reply.code(400).send({
        success: false,
        message: 'status is required',
      });
    }

    // Find shipment
    let shipment = await Shipment.findById(id);
    if (!shipment) {
      shipment = await Shipment.findByTrackingId(id);
    }

    if (!shipment) {
      return reply.code(404).send({
        success: false,
        message: 'Shipment not found',
      });
    }

    try {
      // Update status with timeline event
      await shipment.updateStatus(
        status,
        message || `Status updated to ${status}`,
        messageLocal,
        { source: 'manual', updatedBy: req.user?._id }
      );

      // Handle delivered status
      if (status === 'delivered') {
        shipment.cashCollection.collected = true;
        shipment.cashCollection.collectedAt = new Date();
        await shipment.save();
      }

      return reply.send({
        success: true,
        data: shipment,
        message: `Shipment status updated to ${status}`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // WEBHOOKS
  // ============================================

  async handleWebhook(req, reply) {
    const { provider } = req.params;

    try {
      const shipment = await logisticsService.processWebhook(provider, req.body);

      if (shipment) {
        // Emit event for order status update
        // This can be handled by order module listener
        req.server.log.info(`Webhook processed for shipment ${shipment.trackingId}: ${shipment.status}`);
      }

      return reply.send({ success: true });
    } catch (error) {
      req.server.log.error('Webhook processing error:', error);
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // HEALTH & MONITORING
  // ============================================

  /**
   * Get circuit breaker status for all providers
   * Admin endpoint for monitoring provider health
   */
  async getCircuitStatus(req, reply) {
    const allStatuses = getAllCircuitStatuses();

    return reply.send({
      success: true,
      data: allStatuses,
    });
  }

  /**
   * Reset circuit breaker for a specific provider
   * Admin operation to manually recover from circuit open state
   */
  async resetProviderCircuit(req, reply) {
    const { provider } = req.params;

    resetCircuit(provider);

    return reply.send({
      success: true,
      message: `Circuit breaker for ${provider} has been reset`,
    });
  }
}

export default new LogisticsController();
