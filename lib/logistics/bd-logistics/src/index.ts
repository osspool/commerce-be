/**
 * BD Logistics SDK
 *
 * Production-grade Bangladesh logistics SDK for RedX, Pathao, Steadfast.
 * Features unified API, circuit breaker, automatic retries, and webhook support.
 *
 * For area data (divisions, districts, areas), use @classytic/bd-areas package.
 *
 * @example
 * ```typescript
 * import { createLogisticsClient } from '@classytic/bd-logistics';
 * import { getArea } from '@classytic/bd-areas';
 *
 * // Create client with credentials
 * const logistics = createLogisticsClient({
 *   provider: 'redx',
 *   apiUrl: 'https://sandbox.redx.com.bd/v1.0.0-beta',
 *   apiKey: 'your-api-key',
 * });
 *
 * // Get area and create shipment
 * const area = getArea(1);
 * const result = await logistics.createShipment(order, {
 *   deliveryAreaId: area.providers.redx,
 *   deliveryAreaName: area.name,
 *   pickupStoreId: 1,
 *   cashCollectionAmount: 1000,
 * });
 * ```
 *
 * @module @classytic/bd-logistics
 */

// Types
export type {
  ProviderName,
  ProviderConfig,
  ProviderSettings,
  ShipmentOptions,
  ShipmentResult,
  ShipmentStatus,
  TrackingResult,
  TrackingEvent,
  ShipmentDetails,
  DeliveryInfo,
  PickupInfo,
  CashCollectionInfo,
  ChargeInfo,
  ParcelInfo,
  CancelResult,
  PickupStore,
  CreatePickupStoreData,
  ProviderArea,
  AreaFilters,
  ChargeParams,
  WebhookPayload,
  Order,
  Address,
  OrderItem,
  HttpClient,
  HttpClientConfig,
  CircuitStatus,
  CircuitState,
} from './types.js';

// Errors
export {
  LogisticsError,
  ProviderNotFoundError,
  ProviderAPIError,
  ValidationError,
  CircuitOpenError,
  TimeoutError,
} from './errors.js';

// Providers
import {
  BaseLogisticsProvider,
  RedXProvider,
  createProvider,
  getProviderClass,
  getSupportedProviders,
} from './providers/index.js';

export {
  BaseLogisticsProvider,
  RedXProvider,
  createProvider,
  getProviderClass,
  getSupportedProviders,
};

// HTTP Client
export {
  createHttpClient,
  getAllCircuitStatuses,
  resetCircuit,
} from './http-client.js';

// Main factory function
import type { ProviderConfig } from './types.js';

/**
 * Create a logistics client for a specific provider
 *
 * @param config - Provider configuration
 * @returns Provider instance with all logistics methods
 *
 * @example
 * ```typescript
 * const client = createLogisticsClient({
 *   provider: 'redx',
 *   apiUrl: process.env.REDX_API_URL,
 *   apiKey: process.env.REDX_API_KEY,
 *   settings: { sandbox: true },
 * });
 *
 * // Create COD shipment
 * const shipment = await client.createShipment(order, {
 *   deliveryAreaId: 1,
 *   deliveryAreaName: 'Test Area',
 *   pickupStoreId: 1,
 *   cashCollectionAmount: 1000,
 * });
 *
 * // Track shipment
 * const tracking = await client.trackShipment(shipment.trackingId);
 * ```
 */
export function createLogisticsClient(config: ProviderConfig) {
  return createProvider(config);
}

export default {
  createLogisticsClient,
  createProvider,
  getSupportedProviders,
};
