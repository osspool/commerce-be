/**
 * Manual Payment Provider
 * @classytic/revenue-manual
 *
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 *
 * Use this as a template for building:
 * - @classytic/revenue-stripe
 * - @classytic/revenue-sslcommerz
 * - @classytic/revenue-bkash
 * - Your custom provider
 */

import {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/revenue';
import type {
  CreateIntentParams,
  ProviderCapabilities,
} from '@classytic/revenue';
import { nanoid } from 'nanoid';

/**
 * Configuration options for ManualProvider
 */
export interface ManualProviderConfig {
  [key: string]: unknown;
}

/**
 * Refund options for manual refunds
 */
export interface ManualRefundOptions {
  currency?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Payment info structure for manual payments
 */
interface PaymentInfo {
  [key: string]: string | number | Record<string, unknown>;
}

/**
 * Manual Payment Provider
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 */
export class ManualProvider extends PaymentProvider {
  public override readonly name: string = 'manual';

  constructor(config: ManualProviderConfig = {}) {
    super(config);
  }

  /**
   * Create manual payment intent
   * Returns instructions for manual payment
   */
  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const intentId = `manual_${nanoid(16)}`;

    return new PaymentIntent({
      id: intentId,
      sessionId: null,
      paymentIntentId: null,
      provider: 'manual',
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? 'BDT',
      metadata: params.metadata ?? {},
      instructions: this._getPaymentInstructions(params),
      raw: params,
    });
  }

  /**
   * Verify manual payment
   * For manual provider, verification is done by admin approval
   * When admin calls revenue.payments.verify(), this confirms the payment
   */
  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return new PaymentResult({
      id: intentId,
      provider: 'manual',
      status: 'succeeded', // Admin has verified, mark as succeeded
      amount: 0, // Amount will be filled by transaction
      currency: 'BDT',
      paidAt: new Date(),
      metadata: {
        manuallyVerified: true,
      },
    });
  }

  /**
   * Get payment status
   */
  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  /**
   * Refund manual payment
   */
  async refund(
    _paymentId: string,
    amount?: number | null,
    options: ManualRefundOptions = {}
  ): Promise<RefundResult> {
    const refundId = `refund_${nanoid(16)}`;

    return new RefundResult({
      id: refundId,
      provider: 'manual',
      status: 'succeeded', // Manual refunds are immediately marked as succeeded
      amount: amount ?? 0,
      currency: options.currency ?? 'BDT',
      refundedAt: new Date(),
      reason: options.reason ?? 'Manual refund',
      metadata: options.metadata ?? {},
    });
  }

  /**
   * Manual provider doesn't support webhooks
   */
  async handleWebhook(
    _payload: unknown,
    _headers?: Record<string, string>
  ): Promise<WebhookEvent> {
    throw new Error('Manual provider does not support webhooks');
  }

  /**
   * Get provider capabilities
   */
  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    };
  }

  /**
   * Generate payment instructions for customer
   * @private
   */
  private _getPaymentInstructions(params: CreateIntentParams): string {
    const metadata = params.metadata as Record<string, unknown> | undefined;
    const paymentInfo = metadata?.paymentInfo as PaymentInfo | undefined;
    const paymentInstructions = metadata?.paymentInstructions as string | undefined;

    // If user provided custom instructions, use them
    if (paymentInstructions) {
      return paymentInstructions;
    }

    // Generic fallback
    if (!paymentInfo) {
      return `Payment Amount: ${params.amount} ${params.currency ?? 'BDT'}\n\nPlease contact the organization for payment details.`;
    }

    // Build instructions from paymentInfo
    const lines: string[] = [`Payment Amount: ${params.amount} ${params.currency ?? 'BDT'}`, ''];

    // Add all payment info fields generically
    Object.entries(paymentInfo).forEach(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${key}:`);
        Object.entries(value as Record<string, unknown>).forEach(([subKey, subValue]) => {
          lines.push(`  ${subKey}: ${subValue}`);
        });
      }
    });

    return lines.join('\n');
  }
}

export default ManualProvider;

