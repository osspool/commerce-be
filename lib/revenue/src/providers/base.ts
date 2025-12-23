/**
 * Payment Provider Base Class
 * @classytic/revenue
 *
 * Abstract base class for all payment providers
 * Inspired by: Vercel AI SDK, Stripe SDK
 */

import type {
  CreateIntentParams,
  PaymentIntentData,
  PaymentResultData,
  RefundResultData,
  WebhookEventData,
  ProviderCapabilities,
} from '../types/index.js';

/**
 * Payment Intent - standardized response from createIntent
 */
export class PaymentIntent implements PaymentIntentData {
  public readonly id: string;
  public readonly sessionId: string | null;
  public readonly paymentIntentId: string | null;
  public readonly provider: string;
  public readonly status: string;
  public readonly amount: number;
  public readonly currency: string;
  public readonly metadata: Record<string, unknown>;
  public readonly clientSecret?: string;
  public readonly paymentUrl?: string;
  public readonly instructions?: string;
  public readonly raw?: unknown;

  constructor(data: PaymentIntentData) {
    this.id = data.id;
    this.sessionId = data.sessionId ?? null;
    this.paymentIntentId = data.paymentIntentId ?? null;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency ?? 'BDT';
    this.metadata = data.metadata ?? {};
    this.clientSecret = data.clientSecret;
    this.paymentUrl = data.paymentUrl;
    this.instructions = data.instructions;
    this.raw = data.raw;
  }
}

/**
 * Payment Result - standardized response from verifyPayment
 */
export class PaymentResult implements PaymentResultData {
  public readonly id: string;
  public readonly provider: string;
  public readonly status: 'succeeded' | 'failed' | 'processing';
  public readonly amount?: number;
  public readonly currency: string;
  public readonly paidAt?: Date;
  public readonly metadata: Record<string, unknown>;
  public readonly raw?: unknown;

  constructor(data: PaymentResultData) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency ?? 'BDT';
    this.paidAt = data.paidAt;
    this.metadata = data.metadata ?? {};
    this.raw = data.raw;
  }
}

/**
 * Refund Result - standardized response from refund
 */
export class RefundResult implements RefundResultData {
  public readonly id: string;
  public readonly provider: string;
  public readonly status: 'succeeded' | 'failed' | 'processing';
  public readonly amount?: number;
  public readonly currency: string;
  public readonly refundedAt?: Date;
  public readonly reason?: string;
  public readonly metadata: Record<string, unknown>;
  public readonly raw?: unknown;

  constructor(data: RefundResultData) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency ?? 'BDT';
    this.refundedAt = data.refundedAt;
    this.reason = data.reason;
    this.metadata = data.metadata ?? {};
    this.raw = data.raw;
  }
}

/**
 * Webhook Event - standardized webhook event
 */
export class WebhookEvent implements WebhookEventData {
  public readonly id: string;
  public readonly provider: string;
  public readonly type: string;
  public readonly data: { sessionId?: string; paymentIntentId?: string; [key: string]: unknown };
  public readonly createdAt?: Date;
  public readonly raw?: unknown;

  constructor(data: WebhookEventData) {
    this.id = data.id;
    this.provider = data.provider;
    this.type = data.type;
    this.data = data.data;
    this.createdAt = data.createdAt;
    this.raw = data.raw;
  }
}

/**
 * Base Payment Provider
 * All payment providers must extend this class
 */
export abstract class PaymentProvider {
  public readonly config: Record<string, unknown>;
  public readonly name: string;

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
    this.name = 'base'; // Override in subclass
  }

  /**
   * Create a payment intent
   * @param params - Payment parameters
   * @returns Promise<PaymentIntent>
   */
  abstract createIntent(params: CreateIntentParams): Promise<PaymentIntent>;

  /**
   * Verify a payment
   * @param intentId - Payment intent ID
   * @returns Promise<PaymentResult>
   */
  abstract verifyPayment(intentId: string): Promise<PaymentResult>;

  /**
   * Get payment status
   * @param intentId - Payment intent ID
   * @returns Promise<PaymentResult>
   */
  abstract getStatus(intentId: string): Promise<PaymentResult>;

  /**
   * Refund a payment
   * @param paymentId - Payment ID
   * @param amount - Amount to refund (optional, full refund if not provided)
   * @param options - Refund options
   * @returns Promise<RefundResult>
   */
  abstract refund(
    paymentId: string,
    amount?: number | null,
    options?: { reason?: string }
  ): Promise<RefundResult>;

  /**
   * Handle webhook from provider
   * @param payload - Webhook payload
   * @param headers - Request headers (for signature verification)
   * @returns Promise<WebhookEvent>
   */
  abstract handleWebhook(
    payload: unknown,
    headers?: Record<string, string>
  ): Promise<WebhookEvent>;

  /**
   * Verify webhook signature (optional)
   * @param payload - Webhook payload
   * @param signature - Webhook signature
   * @returns boolean
   */
  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    // Override in subclass if provider supports webhook signatures
    return true;
  }

  /**
   * Get provider capabilities
   * @returns ProviderCapabilities
   */
  getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: false,
      supportsPartialRefunds: false,
      requiresManualVerification: true,
    };
  }
}

export default PaymentProvider;

