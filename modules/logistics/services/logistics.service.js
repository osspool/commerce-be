import config from '../../../config/index.js';
import Shipment from '../models/shipment.model.js';
import { createProvider } from '@classytic/bd-logistics/providers';
import bdAreas from '@classytic/bd-areas';
import platformRepository from '#modules/platform/platform.repository.js';

/**
 * Logistics Service
 *
 * Main orchestrator for logistics operations.
 * Manages provider instances and coordinates shipment lifecycle.
 *
 * Configuration is loaded from .env via config/sections/logistics.config.js
 */
class LogisticsService {
  constructor() {
    this.providers = new Map();
    this.initialized = false;
  }

  /**
   * Initialize service and load provider configs from .env
   */
  async initialize() {
    if (this.initialized) return;

    const logisticsConfig = config.logistics;

    // Initialize each configured provider
    for (const [providerName, providerConfig] of Object.entries(logisticsConfig.providers)) {
      // In tests we still want webhook parsing + status mapping even without real credentials.
      const shouldInitInTests = config.isTest && providerName === 'redx';
      const apiKey = providerConfig.apiKey || (shouldInitInTests ? 'test-key' : null);

      // Only initialize if apiKey is present (provider is configured) OR we're in tests
      if (apiKey) {
        try {
          const provider = createProvider({
            provider: providerName,
            apiUrl: providerConfig.apiUrl,
            apiKey,
          });
          this.providers.set(providerName, provider);
        } catch (error) {
          console.error(`Failed to initialize provider ${providerName}:`, error.message);
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Get provider instance by name
   */
  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Logistics provider '${name}' not configured or not active`);
    }
    return provider;
  }

  /**
   * Get default provider
   */
  async getDefaultProvider() {
    await this.initialize();
    return this.getProvider(config.logistics.defaultProvider);
  }

  // ============================================
  // SHIPMENT OPERATIONS
  // ============================================

  /**
   * Create shipment for an order
   * Uses platform config for default pickup store/area
   *
   * COD Logic:
   * - Cash on delivery only applies when payment method is 'cash'
   * - For prepaid methods (bkash, nagad, bank, card), cash_collection = 0
   * - COD charges only calculated when there's cash to collect
   */
  async createShipment(order, options = {}) {
    await this.initialize();

    // Uses MongoKit cachePlugin (5-min TTL, auto-invalidate on update)
    const platformConfig = await platformRepository.getConfig();
    const logisticsSettings = platformConfig.logistics || {};

    const {
      provider: providerName,
      deliveryAreaId = order.deliveryAddress?.areaId, // Use from order address if not provided
      pickupStoreId = logisticsSettings.defaultPickupStoreId,
      pickupAreaId = logisticsSettings.defaultPickupAreaId,
      weight,
      codAmount,
      instructions,
    } = options;

    const resolvedWeight = weight ?? order?.parcel?.weightGrams ?? 500;

    // Determine COD amount: use explicit codAmount if provided, otherwise auto-calculate
    let cashCollectionAmount;
    if (codAmount !== undefined) {
      cashCollectionAmount = codAmount;
    } else {
      // Auto-calculate: only collect cash on delivery for 'cash' payment method
      const paymentMethod = order.currentPayment?.method || order.paymentMethod || 'cash';
      const paymentStatus = order.currentPayment?.status || 'pending';
      const isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      cashCollectionAmount = isPrepaid ? 0 : (order.totalAmount || 0);
    }

    // Get provider
    const provider = providerName
      ? this.getProvider(providerName)
      : await this.getDefaultProvider();

    // Resolve delivery area for provider
    // Priority: options.providerAreaId > order.providerAreaIds[provider] > bdAreas lookup
    let resolvedAreaId = deliveryAreaId;
    let areaName = options.deliveryAreaName || order.deliveryAddress?.areaName;

    if (options.providerAreaId) {
      // Explicit provider area ID passed in options
      resolvedAreaId = options.providerAreaId;
    } else if (order.deliveryAddress?.providerAreaIds?.[provider.name]) {
      // Use provider-specific ID stored in order (from FE checkout)
      resolvedAreaId = order.deliveryAddress.providerAreaIds[provider.name];
    } else if (deliveryAreaId) {
      // Fallback: resolve via bd-areas package
      const area = bdAreas.getArea(deliveryAreaId);
      if (area) {
        const providerAreaId = area.providers?.[provider.name];
        if (providerAreaId) {
          resolvedAreaId = providerAreaId;
        }
        areaName = areaName || area.name;
      }
    }

    // Calculate charges if not provided
    // COD charge only applies when there's cash to collect
    let charges = options.charges;
    if (!charges && resolvedAreaId && pickupAreaId) {
      try {
        // ChargeParams expects: deliveryAreaId, pickupAreaId, cashCollectionAmount, weight
        charges = await provider.calculateCharge({
          deliveryAreaId: resolvedAreaId,
          pickupAreaId,
          cashCollectionAmount, // COD amount (0 for prepaid)
          weight: resolvedWeight,
        });
      } catch (error) {
        console.warn('Failed to calculate charges:', error.message);
      }
    }

    // Create with provider
    const result = await provider.createShipment(order, {
      deliveryAreaId: resolvedAreaId,
      deliveryAreaName: areaName,
      pickupStoreId,
      weight: resolvedWeight,
      instructions,
      cashCollectionAmount, // Pass the COD amount
    });

    // Create shipment record
    const shipment = await Shipment.create({
      order: order._id,
      provider: provider.name,
      trackingId: result.trackingId,
      providerOrderId: result.providerOrderId,
      status: 'pickup-requested',
      parcel: {
        weight: resolvedWeight,
        value: order.totalAmount,
        itemCount: order.items?.length || 1,
      },
      pickup: {
        storeId: pickupStoreId,
      },
      delivery: {
        // For gift orders: use recipient info from deliveryAddress
        customerName: order.deliveryAddress?.recipientName
          || order.deliveryAddress?.name
          || order.customerName,
        customerPhone: order.deliveryAddress?.recipientPhone
          || order.deliveryAddress?.phone
          || order.customerPhone,
        address: this._buildAddress(order.deliveryAddress),
        areaId: resolvedAreaId,
        areaName,
      },
      cashCollection: {
        amount: cashCollectionAmount,
        isCod: !isPrepaid,
      },
      charges: charges || {},
      merchantInvoiceId: order._id.toString(),
      createdBy: options.userId,
      timeline: [{
        status: 'pickup-requested',
        message: 'Shipment created with provider',
        timestamp: new Date(),
      }],
    });

    return shipment;
  }

  /**
   * Track shipment and update status
   * Also propagates status to order if changed
   */
  async trackShipment(trackingId) {
    await this.initialize();

    const shipment = await Shipment.findByTrackingId(trackingId);
    if (!shipment) {
      throw new Error('Shipment not found');
    }

    const provider = this.getProvider(shipment.provider);
    const trackingData = await provider.trackShipment(trackingId);

    // Update shipment with latest status
    if (trackingData.status !== shipment.status) {
      const latestEvent = trackingData.timeline[trackingData.timeline.length - 1];
      await shipment.updateStatus(
        trackingData.status,
        latestEvent?.message,
        latestEvent?.messageLocal,
        latestEvent?.raw
      );

      // Propagate to order shipping when status changes
      await this._updateOrderShipping(shipment, {
        message: latestEvent?.message,
        messageLocal: latestEvent?.messageLocal,
      });
    }

    return {
      shipment,
      tracking: trackingData,
    };
  }

  /**
   * Cancel shipment
   */
  async cancelShipment(trackingId, reason, userId) {
    await this.initialize();

    const shipment = await Shipment.findByTrackingId(trackingId);
    if (!shipment) {
      throw new Error('Shipment not found');
    }

    // Can only cancel if not delivered/returned
    if (['delivered', 'returned'].includes(shipment.status)) {
      throw new Error(`Cannot cancel shipment in status: ${shipment.status}`);
    }

    const provider = this.getProvider(shipment.provider);
    const result = await provider.cancelShipment(trackingId, reason);

    if (result.success) {
      shipment.status = 'cancelled';
      shipment.cancelledBy = userId;
      shipment.cancelReason = reason;
      shipment.addTimelineEvent('cancelled', reason);
      await shipment.save();
    }

    return {
      success: result.success,
      message: result.message,
      shipment,
    };
  }

  /**
   * Process webhook from provider
   * Updates shipment and propagates status to order
   */
  async processWebhook(providerName, payload) {
    await this.initialize();

    const provider = this.getProvider(providerName);
    const parsed = provider.parseWebhook(payload);

    const shipment = await Shipment.findByTrackingId(parsed.trackingId);
    if (!shipment) {
      console.warn(`Webhook for unknown shipment: ${parsed.trackingId}`);
      return null;
    }

    // Update shipment
    shipment.status = parsed.status;
    shipment.providerStatus = parsed.providerStatus;
    shipment.lastWebhookAt = new Date();
    shipment.webhookCount += 1;

    shipment.addTimelineEvent(
      parsed.status,
      parsed.message,
      parsed.messageLocal,
      parsed.raw
    );

    // Handle delivered status
    if (parsed.status === 'delivered') {
      shipment.cashCollection.collected = true;
      shipment.cashCollection.collectedAt = parsed.timestamp;
    }

    await shipment.save();

    // Propagate shipment status to order shipping
    await this._updateOrderShipping(shipment, parsed);

    return shipment;
  }

  /**
   * Update order shipping status when shipment status changes
   * Maps logistics shipment statuses to order shipping statuses
   */
  async _updateOrderShipping(shipment, parsedWebhook) {
    try {
      // Import shipping service (dynamic to avoid circular dependency)
      const shippingService = (await import('../../commerce/order/shipping.service.js')).default;

      if (!shipment.order) {
        console.warn(`Shipment ${shipment.trackingId} has no linked order`);
        return;
      }

      // Map shipment status to shipping status
      const statusMap = {
        'pickup-requested': 'requested',
        'pickup-pending': 'requested',
        'picked-up': 'picked_up',
        'in-transit': 'in_transit',
        'out-for-delivery': 'out_for_delivery',
        'delivered': 'delivered',
        'returned': 'returned',
        'cancelled': 'cancelled',
        'on-hold': null, // Don't update order for on-hold
      };

      const orderShippingStatus = statusMap[shipment.status];

      if (!orderShippingStatus) {
        console.debug(`Shipment status ${shipment.status} does not map to order shipping status`);
        return;
      }

      // Update order shipping via service (includes validation and events)
      await shippingService.updateStatus(
        shipment.order.toString(),
        {
          status: orderShippingStatus,
          note: parsedWebhook.message || `Status updated via ${shipment.provider} webhook`,
          metadata: {
            provider: shipment.provider,
            providerStatus: shipment.providerStatus,
            trackingId: shipment.trackingId,
            webhookReceivedAt: new Date(),
          },
        },
        {
          actorId: 'system',
          allowBootstrap: true,
          request: null,
        }
      );

      console.info(`Order ${shipment.order} shipping updated to ${orderShippingStatus} from webhook`);
    } catch (error) {
      console.error(`Failed to update order shipping for shipment ${shipment.trackingId}:`, error.message);
      // Don't throw - webhook processing should succeed even if order update fails
    }
  }

  // ============================================
  // PICKUP STORE OPERATIONS (Read-only)
  // ============================================

  /**
   * Get pickup stores from provider
   * Admins create pickup stores via provider dashboard (e.g., RedX dashboard)
   */
  async getPickupStores(providerName) {
    await this.initialize();

    const provider = providerName
      ? this.getProvider(providerName)
      : await this.getDefaultProvider();

    return provider.getPickupStores();
  }

  // ============================================
  // CHARGE CALCULATION
  // ============================================

  /**
   * Calculate delivery charge
   */
  async calculateCharge(params, providerName) {
    await this.initialize();

    const provider = providerName
      ? this.getProvider(providerName)
      : await this.getDefaultProvider();

    return provider.calculateCharge(params);
  }

  // ============================================
  // HELPERS
  // ============================================

  _buildAddress(address) {
    if (!address) return '';
    if (typeof address === 'string') return address;

    const parts = [];
    if (address.addressLine1) parts.push(address.addressLine1);
    if (address.addressLine2) parts.push(address.addressLine2);
    // Use areaName (preferred) or area (deprecated)
    const areaName = address.areaName || address.area;
    if (areaName) parts.push(areaName);
    if (address.city) parts.push(address.city);

    return parts.join(', ');
  }
}

// Singleton instance
const logisticsService = new LogisticsService();

export default logisticsService;
