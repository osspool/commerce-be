/**
 * Base Logistics Provider
 *
 * Abstract interface that all logistics providers must implement.
 * Provides unified API for shipment operations.
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
  HttpClient,
  CircuitStatus,
} from '../types.js';
import { createHttpClient } from '../http-client.js';

export abstract class BaseLogisticsProvider {
  protected config: ProviderConfig;
  protected apiUrl: string;
  protected apiKey: string;
  protected sandbox: boolean;
  protected httpClient: HttpClient;
  public name: string = 'base';

  constructor(config: ProviderConfig) {
    this.config = config;
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.sandbox = config.settings?.sandbox ?? true;

    // Initialize HTTP client with resilience features
    this.httpClient = createHttpClient(this.name, {
      timeout: config.settings?.timeout || 15000,
      maxRetries: config.settings?.maxRetries || 3,
      retryDelay: config.settings?.retryDelay || 1000,
      failureThreshold: config.settings?.circuitBreakerThreshold || 5,
      resetTimeout: config.settings?.circuitBreakerResetTimeout || 30000,
    });
  }

  /**
   * Create shipment/parcel with provider
   */
  abstract createShipment(order: Order, options: ShipmentOptions): Promise<ShipmentResult>;

  /**
   * Track shipment status
   */
  abstract trackShipment(trackingId: string): Promise<TrackingResult>;

  /**
   * Get parcel details from provider
   */
  abstract getShipmentDetails(trackingId: string): Promise<ShipmentDetails>;

  /**
   * Cancel shipment
   */
  abstract cancelShipment(trackingId: string, reason: string): Promise<CancelResult>;

  /**
   * Get all delivery areas from provider
   */
  abstract getAreas(filters?: AreaFilters): Promise<ProviderArea[]>;

  /**
   * Get pickup stores/locations
   */
  abstract getPickupStores(): Promise<PickupStore[]>;

  /**
   * Create pickup store
   */
  abstract createPickupStore(data: CreatePickupStoreData): Promise<PickupStore>;

  /**
   * Get pickup store details
   */
  abstract getPickupStoreDetails(storeId: number): Promise<PickupStore>;

  /**
   * Calculate delivery charge
   */
  abstract calculateCharge(params: ChargeParams): Promise<ChargeInfo>;

  /**
   * Normalize provider status to unified status
   */
  abstract normalizeStatus(providerStatus: string): string;

  /**
   * Parse webhook payload to normalized format
   */
  abstract parseWebhook(payload: Record<string, unknown>): WebhookPayload;

  /**
   * Verify webhook signature
   */
  verifyWebhook(_payload: Record<string, unknown>, _signature: string): boolean {
    return true; // Default: no verification
  }

  /**
   * Helper: Make HTTP request
   */
  protected async _request<T = unknown>(
    method: string,
    endpoint: string,
    options: { body?: unknown } = {}
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;
    const headers = this._getHeaders();

    return this.httpClient.request<T>(method, url, {
      headers,
      body: options.body,
    });
  }

  /**
   * Get default headers for API requests
   */
  protected _getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }

  /**
   * Get circuit breaker status
   */
  getCircuitStatus(): CircuitStatus {
    return this.httpClient.getCircuitStatus();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuit(): void {
    return this.httpClient.resetCircuit();
  }
}

export default BaseLogisticsProvider;
