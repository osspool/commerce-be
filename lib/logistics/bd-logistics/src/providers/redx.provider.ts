/**
 * RedX Logistics Provider
 *
 * Implementation for RedX Bangladesh delivery API.
 * API docs: https://redx.com.bd
 *
 * Supports:
 * - Parcel creation (COD and prepaid)
 * - Parcel tracking
 * - Pickup store management
 * - Delivery charge calculation
 * - Webhook parsing
 */

import type {
  ProviderConfig,
  Order,
  ShipmentOptions,
  ShipmentResult,
  TrackingResult,
  ShipmentDetails,
  CancelResult,
  PickupStore,
  CreatePickupStoreData,
  ProviderArea,
  AreaFilters,
  ChargeParams,
  ChargeInfo,
  WebhookPayload,
  ShipmentStatus,
} from '../types.js';
import { BaseLogisticsProvider } from './base.provider.js';
import { ValidationError } from '../errors.js';

interface RedXParcelResponse {
  tracking_id: string;
}

interface RedXParcelInfo {
  parcel: {
    tracking_id: string;
    status: string;
    customer_name: string;
    customer_phone: string;
    customer_address: string;
    delivery_area_id: number;
    delivery_area: string;
    pickup_location?: {
      id: number;
      name: string;
      address: string;
      area_id: number;
      area_name: string;
    };
    cash_collection_amount: number;
    charge: number;
    parcel_weight: number;
    value: number;
    merchant_invoice_id: string;
    created_at: string;
  };
}

interface RedXTrackingResponse {
  tracking: Array<{
    message_en: string;
    message_bn: string;
    time: string;
  }>;
}

interface RedXAreasResponse {
  areas: ProviderArea[];
}

interface RedXPickupStoresResponse {
  pickup_stores: Array<{
    id: number;
    name: string;
    address: string;
    area_id: number;
    area_name: string;
    phone: string;
    created_at?: string;
  }>;
}

interface RedXStoreResponse {
  id: number;
  name: string;
  address: string;
  area_id: number;
  area_name: string;
  phone: string;
}

interface RedXStoreInfoResponse {
  pickup_store: {
    id: number;
    name: string;
    address: string;
    area_id: number;
    area_name: string;
    phone: string;
    created_at: string;
  };
}

interface RedXChargeResponse {
  deliveryCharge?: number;
  codCharge?: number;
}

interface RedXCancelResponse {
  success: boolean;
  message: string;
}

export class RedXProvider extends BaseLogisticsProvider {
  constructor(config: ProviderConfig) {
    super(config);
    this.name = 'redx';
  }

  protected _getHeaders(): Record<string, string> {
    return {
      'API-ACCESS-TOKEN': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async createShipment(order: Order, options: ShipmentOptions): Promise<ShipmentResult> {
    const {
      deliveryAreaId,
      deliveryAreaName,
      pickupStoreId,
      weight = 500,
      declaredValue,
      instructions,
      cashCollectionAmount = 0,
    } = options;

    // Build parcel details from order items
    const parcelDetails = order.items?.map(item => ({
      name: item.productName,
      category: 'general',
      value: Math.round((item.price || 0) * (item.quantity || 1)),
    })) || [];

    // For gift orders, deliveryAddress has different recipient than customer
    // Priority: recipientName/Phone > name/phone (deprecated) > order.customerName/Phone
    const addr = order.deliveryAddress;
    const recipientName = addr?.recipientName || addr?.name || order.customerName;
    const recipientPhone = addr?.recipientPhone || addr?.phone || order.customerPhone;

    const payload = {
      customer_name: recipientName,
      customer_phone: recipientPhone,
      customer_address: this._buildAddress(order.deliveryAddress),
      delivery_area: deliveryAreaName,
      delivery_area_id: deliveryAreaId,
      cash_collection_amount: String(cashCollectionAmount),
      parcel_weight: weight,
      merchant_invoice_id: order._id?.toString() || order.orderId,
      value: declaredValue || order.totalAmount || 0,
      instruction: instructions || order.notes || '',
      parcel_details_json: parcelDetails,
      pickup_store_id: pickupStoreId || this.config.settings?.defaultPickupStoreId,
    };

    // Validate payload
    this._validateShipmentPayload(payload, order);

    const response = await this._request<RedXParcelResponse>('POST', '/parcel', { body: payload });

    return {
      trackingId: response.tracking_id,
    };
  }

  private _validateShipmentPayload(
    payload: Record<string, unknown>,
    order: Order
  ): void {
    const errors: string[] = [];

    if (!payload.customer_name || String(payload.customer_name).trim() === '') {
      errors.push('customer_name is required (deliveryAddress.recipientName or order.customerName)');
    }

    if (!payload.customer_phone || String(payload.customer_phone).trim() === '') {
      errors.push('customer_phone is required (deliveryAddress.recipientPhone or order.customerPhone)');
    }

    if (!payload.customer_address || String(payload.customer_address).trim() === '') {
      errors.push('customer_address is required (order.deliveryAddress)');
    }

    if (!payload.delivery_area || String(payload.delivery_area).trim() === '') {
      errors.push('delivery_area (area name) is required');
    }

    if (!payload.delivery_area_id) {
      errors.push('delivery_area_id is required');
    }

    if (!payload.merchant_invoice_id) {
      errors.push('merchant_invoice_id is required (order._id)');
    }

    if (!payload.pickup_store_id) {
      errors.push('pickup_store_id is required - provide pickupStoreId in options or set defaultPickupStoreId in config');
    }

    if (errors.length > 0) {
      throw new ValidationError(errors, {
        orderId: order._id?.toString(),
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        areaId: order.deliveryAddress?.areaId,
        areaName: order.deliveryAddress?.areaName,
      });
    }
  }

  async trackShipment(trackingId: string): Promise<TrackingResult> {
    // Get parcel info for current status
    const infoResponse = await this._request<RedXParcelInfo>('GET', `/parcel/info/${trackingId}`);
    const parcel = infoResponse.parcel;

    // Get tracking timeline
    const trackResponse = await this._request<RedXTrackingResponse>('GET', `/parcel/track/${trackingId}`);

    const timeline = (trackResponse.tracking || []).map(event => ({
      status: this._inferStatusFromMessage(event.message_en),
      message: event.message_en,
      messageLocal: event.message_bn,
      timestamp: new Date(event.time),
      raw: event as unknown as Record<string, unknown>,
    }));

    return {
      status: this.normalizeStatus(parcel.status) as ShipmentStatus,
      providerStatus: parcel.status,
      timeline,
    };
  }

  private _inferStatusFromMessage(message: string): string {
    if (!message) return 'updated';

    const messageLower = message.toLowerCase();

    if (messageLower.includes('created') || messageLower.includes('placed')) return 'pending';
    if (messageLower.includes('picked up') || messageLower.includes('pickup')) return 'picked-up';
    if (messageLower.includes('in transit') || messageLower.includes('hub')) return 'in-transit';
    if (messageLower.includes('out for delivery')) return 'out-for-delivery';
    if (messageLower.includes('delivered')) return 'delivered';
    if (messageLower.includes('failed') || messageLower.includes('attempt')) return 'failed-attempt';
    if (messageLower.includes('returned') || messageLower.includes('return')) return 'returned';
    if (messageLower.includes('cancelled')) return 'cancelled';

    return 'updated';
  }

  async getShipmentDetails(trackingId: string): Promise<ShipmentDetails> {
    const response = await this._request<RedXParcelInfo>('GET', `/parcel/info/${trackingId}`);
    const parcel = response.parcel;

    return {
      trackingId: parcel.tracking_id,
      status: this.normalizeStatus(parcel.status) as ShipmentStatus,
      providerStatus: parcel.status,
      delivery: {
        customerName: parcel.customer_name,
        customerPhone: parcel.customer_phone,
        address: parcel.customer_address,
        areaId: parcel.delivery_area_id,
        areaName: parcel.delivery_area,
      },
      pickup: parcel.pickup_location ? {
        storeId: parcel.pickup_location.id,
        storeName: parcel.pickup_location.name,
        address: parcel.pickup_location.address,
        areaId: parcel.pickup_location.area_id,
        areaName: parcel.pickup_location.area_name,
      } : null,
      cashCollection: {
        amount: parcel.cash_collection_amount,
      },
      charges: {
        deliveryCharge: parcel.charge,
      },
      parcel: {
        weight: parcel.parcel_weight,
        value: parcel.value,
      },
      merchantInvoiceId: parcel.merchant_invoice_id,
      createdAt: new Date(parcel.created_at),
      raw: parcel as unknown as Record<string, unknown>,
    };
  }

  async cancelShipment(trackingId: string, reason: string = 'Merchant requested cancellation'): Promise<CancelResult> {
    const payload = {
      entity_type: 'parcel-tracking-id',
      entity_id: trackingId,
      update_details: {
        property_name: 'status',
        new_value: 'cancelled',
        reason,
      },
    };

    const response = await this._request<RedXCancelResponse>('PATCH', '/parcels', { body: payload });

    return {
      success: response.success,
      message: response.message,
    };
  }

  async getAreas(filters: AreaFilters = {}): Promise<ProviderArea[]> {
    let endpoint = '/areas';
    const params: string[] = [];

    if (filters.postCode) {
      params.push(`post_code=${filters.postCode}`);
    }
    if (filters.district) {
      params.push(`district_name=${encodeURIComponent(filters.district)}`);
    }

    if (params.length > 0) {
      endpoint += `?${params.join('&')}`;
    }

    const response = await this._request<RedXAreasResponse>('GET', endpoint);
    return response.areas || [];
  }

  async getPickupStores(): Promise<PickupStore[]> {
    const response = await this._request<RedXPickupStoresResponse>('GET', '/pickup/stores');
    return (response.pickup_stores || []).map(store => ({
      id: store.id,
      name: store.name,
      address: store.address,
      areaId: store.area_id,
      areaName: store.area_name,
      phone: store.phone,
      createdAt: store.created_at ? new Date(store.created_at) : undefined,
    }));
  }

  async createPickupStore(data: CreatePickupStoreData): Promise<PickupStore> {
    const payload = {
      name: data.name,
      phone: data.phone,
      address: data.address,
      area_id: data.areaId,
    };

    const response = await this._request<RedXStoreResponse>('POST', '/pickup/store', { body: payload });

    return {
      id: response.id,
      name: response.name,
      address: response.address,
      areaId: response.area_id,
      areaName: response.area_name,
      phone: response.phone,
    };
  }

  async getPickupStoreDetails(storeId: number): Promise<PickupStore> {
    const response = await this._request<RedXStoreInfoResponse>('GET', `/pickup/store/info/${storeId}`);
    const store = response.pickup_store;

    return {
      id: store.id,
      name: store.name,
      address: store.address,
      areaId: store.area_id,
      areaName: store.area_name,
      phone: store.phone,
      createdAt: new Date(store.created_at),
    };
  }

  async calculateCharge(params: ChargeParams): Promise<ChargeInfo> {
    const { deliveryAreaId, pickupAreaId, cashCollectionAmount, weight } = params;

    const endpoint = `/charge/charge_calculator?` +
      `delivery_area_id=${deliveryAreaId}` +
      `&pickup_area_id=${pickupAreaId}` +
      `&cash_collection_amount=${cashCollectionAmount}` +
      `&weight=${weight}`;

    const response = await this._request<RedXChargeResponse>('GET', endpoint);

    return {
      deliveryCharge: response.deliveryCharge || 0,
      codCharge: response.codCharge || 0,
      totalCharge: (response.deliveryCharge || 0) + (response.codCharge || 0),
    };
  }

  normalizeStatus(redxStatus: string): string {
    const statusMap: Record<string, ShipmentStatus> = {
      'pickup-pending': 'pickup-requested',
      'ready-for-delivery': 'picked-up',
      'delivery-in-progress': 'out-for-delivery',
      'delivered': 'delivered',
      'agent-hold': 'in-transit',
      'agent-returning': 'returning',
      'agent-area-change': 'in-transit',
      'returned': 'returned',
      'cancelled': 'cancelled',
    };

    return statusMap[redxStatus] || 'pending';
  }

  parseWebhook(payload: Record<string, unknown>): WebhookPayload {
    return {
      trackingId: payload.tracking_number as string,
      status: this.normalizeStatus(payload.status as string) as ShipmentStatus,
      providerStatus: payload.status as string,
      message: payload.message_en as string,
      messageLocal: payload.message_bn as string | undefined,
      timestamp: new Date(payload.timestamp as string),
      merchantInvoiceId: payload.invoice_number as string | undefined,
      raw: payload,
    };
  }

  private _buildAddress(address?: Order['deliveryAddress']): string {
    if (!address) return '';
    if (typeof address === 'string') return address;

    const parts: string[] = [];
    if (address.addressLine1) parts.push(address.addressLine1);
    if (address.addressLine2) parts.push(address.addressLine2);
    // Use areaName (preferred) or area (deprecated)
    const areaName = address.areaName || address.area;
    if (areaName) parts.push(areaName);
    if (address.city) parts.push(address.city);

    return parts.join(', ');
  }
}

export default RedXProvider;
