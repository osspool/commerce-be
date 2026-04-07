import config from '../../../config/index.js';
import { createProvider } from '@classytic/bd-logistics/providers';
import bdAreas from '@classytic/bd-areas';
import platformRepository from '#resources/platform/platform.repository.js';
import Order from '#resources/sales/orders/order.model.js';

interface ProviderConfig {
  apiUrl: string;
  apiKey: string;
  isSandbox: boolean;
}

interface LogisticsProvider {
  name: string;
  createShipment: (
    order: unknown,
    options: Record<string, unknown>,
  ) => Promise<{ trackingId: string; providerOrderId: string }>;
  trackShipment: (
    trackingNumber: string,
  ) => Promise<{ status: string; timeline: Array<{ message?: string; messageLocal?: string; raw?: unknown }> }>;
  cancelShipment: (trackingNumber: string, reason: string) => Promise<{ success: boolean; message: string }>;
  parseWebhook: (payload: unknown) => {
    trackingId: string;
    status: string;
    providerStatus?: string;
    message?: string;
    messageLocal?: string;
    timestamp?: Date;
    raw?: unknown;
  };
  getPickupStores: () => Promise<unknown[]>;
  calculateCharge: (params: ChargeParams) => Promise<Record<string, unknown>>;
}

interface ChargeParams {
  deliveryAreaId: number;
  pickupAreaId: number;
  cashCollectionAmount: number;
  weight: number;
}

interface ShipmentOptions {
  provider?: string;
  deliveryAreaId?: number;
  deliveryAreaName?: string;
  providerAreaId?: number;
  pickupStoreId?: number;
  pickupAreaId?: number;
  weight?: number;
  codAmount?: number;
  instructions?: string;
  charges?: Record<string, unknown>;
}

type ShippingStatus =
  | 'requested'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_attempt'
  | 'returned'
  | 'cancelled';

const STATUS_MAP: Record<string, ShippingStatus | null> = {
  'pickup-requested': 'requested',
  'pickup-pending': 'requested',
  'picked-up': 'picked_up',
  'in-transit': 'in_transit',
  'out-for-delivery': 'out_for_delivery',
  delivered: 'delivered',
  'failed-attempt': 'failed_attempt',
  returning: 'returned',
  returned: 'returned',
  cancelled: 'cancelled',
  'on-hold': null,
};

/**
 * Logistics Service
 *
 * Main orchestrator for logistics operations.
 * Manages provider instances and coordinates shipment lifecycle.
 */
class LogisticsService {
  private providers: Map<string, LogisticsProvider>;
  private initialized: boolean;

  constructor() {
    this.providers = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const logisticsConfig = config.logistics;

    for (const [providerName, providerConfig] of Object.entries(
      logisticsConfig.providers as Record<string, ProviderConfig>,
    )) {
      const shouldInitInTests = config.isTest && providerName === 'redx';
      const apiKey = providerConfig.apiKey || (shouldInitInTests ? 'test-key' : null);

      if (apiKey) {
        try {
          const provider = createProvider({
            provider: providerName as any,
            apiUrl: providerConfig.apiUrl,
            apiKey,
          }) as unknown as LogisticsProvider;
          provider.name = providerName;
          this.providers.set(providerName, provider);
        } catch (error) {
          const err = error as Error;
          console.error(`Failed to initialize provider ${providerName}:`, err.message);
        }
      }
    }

    this.initialized = true;
  }

  getProvider(name: string): LogisticsProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Logistics provider '${name}' not configured or not active`);
    }
    return provider;
  }

  async getDefaultProvider(): Promise<LogisticsProvider> {
    await this.initialize();
    return this.getProvider(config.logistics.defaultProvider as string);
  }

  // ============================================
  // SHIPMENT OPERATIONS
  // ============================================

  async createShipment(order: Record<string, unknown>, options: ShipmentOptions = {}) {
    await this.initialize();

    const platformConfig = await platformRepository.getConfig();
    const logisticsSettings = ((platformConfig as Record<string, unknown>).logistics as Record<string, unknown>) || {};

    const {
      provider: providerName,
      deliveryAreaId = (order.deliveryAddress as Record<string, unknown>)?.areaId as number | undefined,
      pickupStoreId = logisticsSettings.defaultPickupStoreId as number | undefined,
      pickupAreaId = logisticsSettings.defaultPickupAreaId as number | undefined,
      weight,
      codAmount,
      instructions,
    } = options;

    const resolvedWeight = weight ?? ((order?.parcel as Record<string, unknown>)?.weightGrams as number) ?? 500;

    let cashCollectionAmount: number;
    let isPrepaid = false;
    if (codAmount !== undefined) {
      cashCollectionAmount = codAmount;
    } else {
      const paymentMethod =
        ((order.currentPayment as Record<string, unknown>)?.method as string) ||
        (order.paymentMethod as string) ||
        'cash';
      const paymentStatus = ((order.currentPayment as Record<string, unknown>)?.status as string) || 'pending';
      isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      cashCollectionAmount = isPrepaid ? 0 : (order.totalAmount as number) || 0;
    }

    const provider = providerName ? this.getProvider(providerName) : await this.getDefaultProvider();

    let resolvedAreaId: number | undefined = deliveryAreaId;
    let areaName = options.deliveryAreaName || ((order.deliveryAddress as Record<string, unknown>)?.areaName as string);

    if (options.providerAreaId) {
      resolvedAreaId = options.providerAreaId;
      console.info(`[Logistics] Using explicit providerAreaId: ${resolvedAreaId}`);
    } else if ((order.deliveryAddress as Record<string, unknown>)?.providerAreaIds) {
      const providerAreaIds = (order.deliveryAddress as Record<string, unknown>).providerAreaIds as Record<
        string,
        number
      >;
      if (providerAreaIds[provider.name]) {
        resolvedAreaId = providerAreaIds[provider.name];
        console.info(`[Logistics] Using order.providerAreaIds.${provider.name}: ${resolvedAreaId}`);
      }
    } else if (deliveryAreaId) {
      const area = bdAreas.getArea(deliveryAreaId);
      if (area) {
        const providerAreaId = (area.providers as unknown as Record<string, number>)?.[provider.name];
        if (providerAreaId) {
          resolvedAreaId = providerAreaId;
          console.info(
            `[Logistics] Resolved via bdAreas: areaId=${deliveryAreaId} -> ${provider.name}=${resolvedAreaId}`,
          );
        } else {
          console.warn(
            `[Logistics] Area ${deliveryAreaId} found but no ${provider.name} mapping. providers:`,
            area.providers,
          );
        }
        areaName = areaName || area.name;
      } else {
        console.warn(`[Logistics] Area ${deliveryAreaId} NOT FOUND in bdAreas. Using raw areaId.`);
      }
    }

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
        const err = error as Error;
        console.warn('Failed to calculate charges:', err.message);
      }
    }

    const result = await provider.createShipment(order, {
      deliveryAreaId: resolvedAreaId,
      deliveryAreaName: areaName,
      pickupStoreId,
      weight: resolvedWeight,
      instructions,
      cashCollectionAmount,
    });

    const now = new Date();
    (order as Record<string, unknown>).shipping = {
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
      history: [
        {
          status: 'requested',
          note: `Shipment created via ${provider.name} API`,
          timestamp: now,
        },
      ],
    };

    await (order as Record<string, () => Promise<void>>).save();

    return {
      trackingId: result.trackingId,
      providerOrderId: result.providerOrderId,
      order,
    };
  }

  async findOrderByTrackingNumber(trackingNumber: string) {
    return Order.findOne({ 'shipping.trackingNumber': trackingNumber });
  }

  async trackShipment(trackingNumber: string) {
    await this.initialize();

    const order = await this.findOrderByTrackingNumber(trackingNumber);
    if (!order) {
      throw new Error('Shipment not found');
    }

    const provider = this.getProvider(order.shipping.provider);
    const trackingData = await provider.trackShipment(trackingNumber);

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

  async cancelShipment(trackingNumber: string, reason: string, userId?: string) {
    await this.initialize();

    const order = await this.findOrderByTrackingNumber(trackingNumber);
    if (!order) {
      throw new Error('Shipment not found');
    }

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

  async processWebhook(providerName: string, payload: unknown) {
    await this.initialize();

    const provider = this.getProvider(providerName);
    const parsed = provider.parseWebhook(payload);

    const order = await this.findOrderByTrackingNumber(parsed.trackingId);
    if (!order) {
      console.warn(`Webhook for unknown shipment: ${parsed.trackingId}`);
      return null;
    }

    const newStatus = this._mapProviderStatus(parsed.status);

    if (newStatus) {
      order.shipping.status = newStatus;
    }
    order.shipping.providerStatus = parsed.providerStatus || parsed.status;
    order.shipping.lastWebhookAt = new Date();
    order.shipping.webhookCount = (order.shipping.webhookCount || 0) + 1;

    this._updateTimestamps(order.shipping, newStatus);

    if (parsed.status === 'delivered' && order.shipping.cashCollection) {
      order.shipping.cashCollection.collected = true;
      order.shipping.cashCollection.collectedAt = parsed.timestamp || new Date();
    }

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

  _mapProviderStatus(providerStatus: string): ShippingStatus | null {
    return STATUS_MAP[providerStatus] || null;
  }

  _updateTimestamps(shipping: Record<string, unknown>, status: ShippingStatus | null): void {
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

  async getPickupStores(providerName?: string): Promise<unknown[]> {
    await this.initialize();

    const provider = providerName ? this.getProvider(providerName) : await this.getDefaultProvider();

    return provider.getPickupStores();
  }

  // ============================================
  // CHARGE CALCULATION
  // ============================================

  async calculateCharge(params: ChargeParams, providerName?: string) {
    await this.initialize();

    const provider = providerName ? this.getProvider(providerName) : await this.getDefaultProvider();

    return provider.calculateCharge(params);
  }

  // ============================================
  // HELPERS
  // ============================================

  _buildAddress(address: unknown): string {
    if (!address) return '';
    if (typeof address === 'string') return address;

    const addr = address as Record<string, string>;
    const parts: string[] = [];
    if (addr.addressLine1) parts.push(addr.addressLine1);
    if (addr.addressLine2) parts.push(addr.addressLine2);
    const areaName = addr.areaName || addr.area;
    if (areaName) parts.push(areaName);
    if (addr.city) parts.push(addr.city);

    return parts.join(', ');
  }
}

// Singleton instance
const logisticsService = new LogisticsService();

export default logisticsService;
