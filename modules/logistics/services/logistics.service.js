import config from '../../../config/index.js';
import { createProvider } from '@classytic/bd-logistics/providers';
import bdAreas from '@classytic/bd-areas';
import platformRepository from '#modules/platform/platform.repository.js';
import Order from '#modules/sales/orders/order.model.js';

/**
 * Logistics Service
 *
 * Main orchestrator for logistics operations.
 * Manages provider instances and coordinates shipment lifecycle.
 *
 * Shipment data is stored in Order.shipping (consolidated model).
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
      deliveryAreaId = order.deliveryAddress?.areaId,
      pickupStoreId = logisticsSettings.defaultPickupStoreId,
      pickupAreaId = logisticsSettings.defaultPickupAreaId,
      weight,
      codAmount,
      instructions,
    } = options;

    const resolvedWeight = weight ?? order?.parcel?.weightGrams ?? 500;

    // Determine COD amount: use explicit codAmount if provided, otherwise auto-calculate
    let cashCollectionAmount;
    let isPrepaid = false;
    if (codAmount !== undefined) {
      cashCollectionAmount = codAmount;
    } else {
      // Auto-calculate: only collect cash on delivery for 'cash' payment method
      const paymentMethod = order.currentPayment?.method || order.paymentMethod || 'cash';
      const paymentStatus = order.currentPayment?.status || 'pending';
      isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      cashCollectionAmount = isPrepaid ? 0 : (order.totalAmount || 0);
    }

    // Get provider
    const provider = providerName
      ? this.getProvider(providerName)
      : await this.getDefaultProvider();

    // Resolve delivery area for provider
    let resolvedAreaId = deliveryAreaId;
    let areaName = options.deliveryAreaName || order.deliveryAddress?.areaName;

    if (options.providerAreaId) {
      resolvedAreaId = options.providerAreaId;
    } else if (order.deliveryAddress?.providerAreaIds?.[provider.name]) {
      resolvedAreaId = order.deliveryAddress.providerAreaIds[provider.name];
    } else if (deliveryAreaId) {
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
    let charges = options.charges;
    if (!charges && resolvedAreaId && pickupAreaId) {
      try {
        charges = await provider.calculateCharge({
          deliveryAreaId: resolvedAreaId,
          pickupAreaId,
          cashCollectionAmount,
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
      cashCollectionAmount,
    });

    // Update order.shipping directly (consolidated model)
    const now = new Date();
    order.shipping = {
      provider: provider.name,
      status: 'requested',
      trackingNumber: result.trackingId,
      providerOrderId: result.providerOrderId,
      providerStatus: 'pickup-requested',
      requestedAt: now,
      pickup: {
        storeId: pickupStoreId,
      },
      charges: charges || {},
      cashCollection: {
        amount: cashCollectionAmount,
      },
      webhookCount: 0,
      history: [{
        status: 'requested',
        note: `Shipment created via ${provider.name} API`,
        timestamp: now,
      }],
    };

    await order.save();

    return {
      trackingId: result.trackingId,
      providerOrderId: result.providerOrderId,
      order,
    };
  }

  /**
   * Find order by tracking number
   */
  async findOrderByTrackingNumber(trackingNumber) {
    return Order.findOne({ 'shipping.trackingNumber': trackingNumber });
  }

  /**
   * Track shipment and update status
   */
  async trackShipment(trackingNumber) {
    await this.initialize();

    const order = await this.findOrderByTrackingNumber(trackingNumber);
    if (!order) {
      throw new Error('Shipment not found');
    }

    const provider = this.getProvider(order.shipping.provider);
    const trackingData = await provider.trackShipment(trackingNumber);

    // Update order.shipping with latest status
    const currentStatus = order.shipping.status;
    const newStatus = this._mapProviderStatus(trackingData.status);

    if (newStatus && newStatus !== currentStatus) {
      const latestEvent = trackingData.timeline[trackingData.timeline.length - 1];

      order.shipping.status = newStatus;
      order.shipping.providerStatus = trackingData.status;
      this._updateTimestamps(order.shipping, newStatus);

      order.shipping.history = order.shipping.history || [];
      order.shipping.history.push({
        status: newStatus,
        note: latestEvent?.message,
        noteLocal: latestEvent?.messageLocal,
        timestamp: new Date(),
        raw: latestEvent?.raw,
      });

      await order.save();
      console.info(`Order ${order._id} shipping updated to ${newStatus} from tracking`);
    }

    return {
      order,
      tracking: trackingData,
    };
  }

  /**
   * Cancel shipment
   */
  async cancelShipment(trackingNumber, reason, userId) {
    await this.initialize();

    const order = await this.findOrderByTrackingNumber(trackingNumber);
    if (!order) {
      throw new Error('Shipment not found');
    }

    // Can only cancel if not delivered/returned
    if (['delivered', 'returned'].includes(order.shipping.status)) {
      throw new Error(`Cannot cancel shipment in status: ${order.shipping.status}`);
    }

    const provider = this.getProvider(order.shipping.provider);
    const result = await provider.cancelShipment(trackingNumber, reason);

    if (result.success) {
      order.shipping.status = 'cancelled';
      order.shipping.providerStatus = 'cancelled';
      order.shipping.history = order.shipping.history || [];
      order.shipping.history.push({
        status: 'cancelled',
        note: reason,
        actor: userId?.toString(),
        timestamp: new Date(),
      });
      await order.save();
    }

    return {
      success: result.success,
      message: result.message,
      order,
    };
  }

  /**
   * Process webhook from provider
   * Updates order.shipping directly
   */
  async processWebhook(providerName, payload) {
    await this.initialize();

    const provider = this.getProvider(providerName);
    const parsed = provider.parseWebhook(payload);

    const order = await this.findOrderByTrackingNumber(parsed.trackingId);
    if (!order) {
      console.warn(`Webhook for unknown shipment: ${parsed.trackingId}`);
      return null;
    }

    // Map provider status to order shipping status
    const newStatus = this._mapProviderStatus(parsed.status);

    // Update order.shipping
    if (newStatus) {
      order.shipping.status = newStatus;
    }
    order.shipping.providerStatus = parsed.providerStatus || parsed.status;
    order.shipping.lastWebhookAt = new Date();
    order.shipping.webhookCount = (order.shipping.webhookCount || 0) + 1;

    // Update timestamps based on status
    this._updateTimestamps(order.shipping, newStatus);

    // Handle delivered status - COD collected
    if (parsed.status === 'delivered' && order.shipping.cashCollection) {
      order.shipping.cashCollection.collected = true;
      order.shipping.cashCollection.collectedAt = parsed.timestamp || new Date();
    }

    // Add to history
    order.shipping.history = order.shipping.history || [];
    order.shipping.history.push({
      status: newStatus || order.shipping.status,
      note: parsed.message,
      noteLocal: parsed.messageLocal,
      timestamp: new Date(),
      raw: parsed.raw,
    });

    await order.save();
    console.info(`Order ${order._id} shipping updated to ${newStatus} from webhook`);

    return order;
  }

  /**
   * Map provider shipment status to order shipping status
   */
  _mapProviderStatus(providerStatus) {
    const statusMap = {
      'pickup-requested': 'requested',
      'pickup-pending': 'requested',
      'picked-up': 'picked_up',
      'in-transit': 'in_transit',
      'out-for-delivery': 'out_for_delivery',
      'delivered': 'delivered',
      'failed-attempt': 'failed_attempt',
      'returning': 'returned',
      'returned': 'returned',
      'cancelled': 'cancelled',
      'on-hold': null, // Don't update for on-hold
    };
    return statusMap[providerStatus] || null;
  }

  /**
   * Update timestamps based on status
   */
  _updateTimestamps(shipping, status) {
    const now = new Date();
    switch (status) {
      case 'requested':
        shipping.requestedAt = shipping.requestedAt || now;
        break;
      case 'picked_up':
        shipping.pickedUpAt = now;
        break;
      case 'delivered':
        shipping.deliveredAt = now;
        break;
    }
  }

  // ============================================
  // PICKUP STORE OPERATIONS (Read-only)
  // ============================================

  /**
   * Get pickup stores from provider
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
    const areaName = address.areaName || address.area;
    if (areaName) parts.push(areaName);
    if (address.city) parts.push(address.city);

    return parts.join(', ');
  }
}

// Singleton instance
const logisticsService = new LogisticsService();

export default logisticsService;
