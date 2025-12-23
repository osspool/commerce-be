/**
 * BD Logistics SDK Type Definitions
 *
 * Production-grade types for Bangladesh logistics providers
 *
 * @module @classytic/bd-logistics
 */

// ============================================================================
// Provider Types
// ============================================================================

/** Supported logistics providers */
export type ProviderName = 'redx' | 'pathao' | 'steadfast';

/** Provider configuration */
export interface ProviderConfig {
  /** Provider name */
  provider: ProviderName;
  /** Provider API base URL */
  apiUrl: string;
  /** Provider API key/token */
  apiKey: string;
  /** Optional provider settings */
  settings?: ProviderSettings;
}

/** Provider settings */
export interface ProviderSettings {
  /** Use sandbox mode */
  sandbox?: boolean;
  /** Request timeout in ms (default: 15000) */
  timeout?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000) */
  retryDelay?: number;
  /** Default pickup store ID */
  defaultPickupStoreId?: number;
  /** Circuit breaker failure threshold (default: 5) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  circuitBreakerResetTimeout?: number;
}

// ============================================================================
// Unified Area Types (Bangladesh)
// ============================================================================

/** Provider-specific area IDs */
export interface ProviderAreaIds {
  /** RedX area ID */
  redx?: number;
  /** Pathao area ID */
  pathao?: number;
  /** Steadfast area ID */
  steadfast?: number;
}

/**
 * Bangladesh Division
 *
 * 8 administrative divisions of Bangladesh
 */
export interface Division {
  /** Unique identifier (e.g., "dhaka") */
  id: string;
  /** English name (e.g., "Dhaka") */
  name: string;
  /** Bengali name (e.g., "ঢাকা") */
  nameLocal: string;
}

/**
 * Bangladesh District
 *
 * 64 districts across 8 divisions
 */
export interface District {
  /** Unique identifier (e.g., "gazipur") */
  id: string;
  /** English name (e.g., "Gazipur") */
  name: string;
  /** Parent division ID */
  divisionId: string;
  /** Parent division name */
  divisionName: string;
}

/**
 * Unified Delivery Area
 *
 * Represents a delivery area with multi-provider support.
 * Use `internalId` in your database, then get provider-specific IDs
 * from `providers` when making API calls.
 *
 * @example
 * const area = areas.getArea(1);
 * // Store in DB: address.areaId = area.internalId
 * // Call RedX: deliveryAreaId = area.providers.redx
 */
export interface BDArea {
  /** Internal ID for your system (use this in your database) */
  internalId: number;
  /** Area name (e.g., "Mohammadpur") */
  name: string;
  /** Postal code (nullable) */
  postCode: number | null;
  /** Zone ID for delivery pricing */
  zoneId: number;
  /** District ID */
  districtId: string;
  /** District name */
  districtName: string;
  /** Division ID */
  divisionId: string;
  /** Division name */
  divisionName: string;
  /** Provider-specific area IDs for API calls */
  providers: ProviderAreaIds;
}

/**
 * Resolved area with full division and district objects
 *
 * Use this when you need complete geographic context
 */
export interface BDAreaResolved extends BDArea {
  /** Full division object */
  division: Division;
  /** Full district object */
  district: District;
}

/**
 * Area statistics
 */
export interface AreaStats {
  divisions: number;
  districts: number;
  areas: number;
  providerCoverage: {
    redx: number;
    pathao: number;
    steadfast: number;
  };
  byDivision: Array<{
    division: string;
    districts: number;
    areas: number;
  }>;
}

// ============================================================================
// Provider API Area Types (for API responses)
// ============================================================================

/** Area from provider API response */
export interface ProviderArea {
  id: number;
  name: string;
  division_name?: string;
  district_name?: string;
  post_code?: number;
}

/** Area filter options for provider API */
export interface AreaFilters {
  postCode?: string;
  district?: string;
}

// ============================================================================
// Shipment Types
// ============================================================================

/** Shipment creation options */
export interface ShipmentOptions {
  /** Delivery area ID (provider-specific, get from BDArea.providers) */
  deliveryAreaId: number;
  /** Delivery area name */
  deliveryAreaName?: string;
  /** Pickup store ID */
  pickupStoreId?: number;
  /** Parcel weight in grams */
  weight?: number;
  /** Declared value for insurance */
  declaredValue?: number;
  /** Delivery instructions */
  instructions?: string;
  /** COD amount (0 for prepaid) */
  cashCollectionAmount?: number;
}

/** Shipment creation result */
export interface ShipmentResult {
  /** Provider tracking ID */
  trackingId: string;
  /** Provider internal order ID */
  providerOrderId?: string;
}

/** Unified shipment status */
export type ShipmentStatus =
  | 'pending'
  | 'pickup-requested'
  | 'picked-up'
  | 'in-transit'
  | 'out-for-delivery'
  | 'delivered'
  | 'failed-attempt'
  | 'returning'
  | 'returned'
  | 'cancelled'
  | 'on-hold';

/** Tracking result */
export interface TrackingResult {
  /** Normalized status */
  status: ShipmentStatus;
  /** Provider's raw status */
  providerStatus: string;
  /** Tracking timeline */
  timeline: TrackingEvent[];
}

/** Tracking event */
export interface TrackingEvent {
  /** Event status */
  status: string;
  /** Event message (English) */
  message: string;
  /** Event message (local language) */
  messageLocal?: string;
  /** Event timestamp */
  timestamp: Date;
  /** Raw provider data */
  raw?: Record<string, unknown>;
}

/** Shipment details */
export interface ShipmentDetails {
  /** Tracking ID */
  trackingId: string;
  /** Normalized status */
  status: ShipmentStatus;
  /** Provider's raw status */
  providerStatus: string;
  /** Delivery information */
  delivery: DeliveryInfo;
  /** Pickup information */
  pickup: PickupInfo | null;
  /** COD information */
  cashCollection: CashCollectionInfo;
  /** Charge information */
  charges: ChargeInfo;
  /** Parcel information */
  parcel: ParcelInfo;
  /** Merchant's invoice/order ID */
  merchantInvoiceId: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Raw provider response */
  raw: Record<string, unknown>;
}

/** Delivery information */
export interface DeliveryInfo {
  customerName: string;
  customerPhone: string;
  address: string;
  areaId: number;
  areaName: string;
}

/** Pickup information */
export interface PickupInfo {
  storeId: number;
  storeName: string;
  address: string;
  areaId: number;
  areaName: string;
}

/** Cash collection information */
export interface CashCollectionInfo {
  amount: number;
}

/** Charge information */
export interface ChargeInfo {
  deliveryCharge: number;
  codCharge?: number;
  totalCharge?: number;
}

/** Parcel information */
export interface ParcelInfo {
  weight: number;
  value: number;
}

/** Cancellation result */
export interface CancelResult {
  success: boolean;
  message: string;
}

// ============================================================================
// Pickup Store Types
// ============================================================================

/** Pickup store */
export interface PickupStore {
  id: number;
  name: string;
  address: string;
  areaId: number;
  areaName: string;
  phone: string;
  createdAt?: Date;
}

/** Pickup store creation data */
export interface CreatePickupStoreData {
  name: string;
  phone: string;
  address: string;
  areaId: number;
}

// ============================================================================
// Charge Calculation Types
// ============================================================================

/** Charge calculation parameters (per RedX API) */
export interface ChargeParams {
  /** Delivery area ID (required) */
  deliveryAreaId: number;
  /** Pickup area ID (required) */
  pickupAreaId: number;
  /** Cash collection amount - COD amount to collect (required) */
  cashCollectionAmount: number;
  /** Parcel weight in grams (required) */
  weight: number;
}

// ============================================================================
// Webhook Types
// ============================================================================

/** Parsed webhook payload */
export interface WebhookPayload {
  trackingId: string;
  status: ShipmentStatus;
  providerStatus: string;
  message: string;
  messageLocal?: string;
  timestamp: Date;
  merchantInvoiceId?: string;
  raw: Record<string, unknown>;
}

// ============================================================================
// Order Types (for createShipment)
// ============================================================================

/** Order interface for createShipment */
export interface Order {
  _id?: string | { toString(): string };
  orderId?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: Address;
  items?: OrderItem[];
  totalAmount?: number;
  notes?: string;
}

/** Address */
export interface Address {
  /** Recipient name (for gift orders, different from customer) */
  recipientName?: string;
  /** Recipient phone (for gift orders, different from customer) */
  recipientPhone?: string;
  /** @deprecated Use recipientName instead */
  name?: string;
  /** @deprecated Use recipientPhone instead */
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  /** @deprecated Use areaName instead */
  area?: string;
  city?: string;
  areaId?: number;
  areaName?: string;
}

/** Order item */
export interface OrderItem {
  productName: string;
  price: number;
  quantity: number;
}

// ============================================================================
// HTTP Client Types
// ============================================================================

/** HTTP client configuration */
export interface HttpClientConfig {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  retryableStatuses?: number[];
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenMaxRequests?: number;
}

/** Circuit breaker state */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Circuit breaker status */
export interface CircuitStatus {
  name: string;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
}

/** HTTP client interface */
export interface HttpClient {
  get<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  post<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  patch<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  put<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  delete<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  request<T = unknown>(method: string, url: string, options?: HttpRequestOptions): Promise<T>;
  getCircuitStatus(): CircuitStatus;
  resetCircuit(): void;
}

/** HTTP request options */
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

