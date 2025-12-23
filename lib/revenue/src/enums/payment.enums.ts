/**
 * Payment Enums
 * @classytic/revenue
 *
 * Library-managed payment enums only.
 * Users define their own payment methods in their schema.
 */

// ============ PAYMENT STATUS ============
/**
 * Payment Status - Library-managed states
 */
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
} as const;

export type PaymentStatus = typeof PAYMENT_STATUS;
export type PaymentStatusValue = PaymentStatus[keyof PaymentStatus];
export const PAYMENT_STATUS_VALUES = Object.values(
  PAYMENT_STATUS,
) as PaymentStatusValue[];

// ============ PAYMENT GATEWAY TYPES ============
/**
 * Common gateway type constants for convenience
 *
 * ⚠️ IMPORTANT: These are NOT restrictions - just common reference values
 *
 * You can register ANY custom gateway provider by passing it to createRevenue():
 *
 * @example
 * ```typescript
 * const revenue = createRevenue({
 *   providers: {
 *     manual: new ManualProvider(),
 *     bkash: new BkashProvider(),      // ✅ Custom gateway
 *     nagad: new NagadProvider(),      // ✅ Custom gateway
 *     stripe: new StripeProvider(),    // ✅ Custom gateway
 *     paypal: new PaypalProvider(),    // ✅ Any gateway you want
 *   }
 * });
 *
 * // Use by name
 * await revenue.monetization.create({ gateway: 'bkash', ... });
 * ```
 *
 * Reference values:
 * - MANUAL: Built-in manual provider (@classytic/revenue-manual)
 * - STRIPE: Stripe provider (build with @classytic/revenue-stripe)
 * - SSLCOMMERZ: SSLCommerz provider (build with @classytic/revenue-sslcommerz)
 *
 * Add your own: bkash, nagad, rocket, paypal, razorpay, flutterwave, etc.
 */
export const PAYMENT_GATEWAY_TYPE = {
  MANUAL: 'manual',
  STRIPE: 'stripe',
  SSLCOMMERZ: 'sslcommerz',
} as const;

export type PaymentGatewayType = typeof PAYMENT_GATEWAY_TYPE;
export type PaymentGatewayTypeValue = PaymentGatewayType[keyof PaymentGatewayType];
export const PAYMENT_GATEWAY_TYPE_VALUES = Object.values(
  PAYMENT_GATEWAY_TYPE,
) as PaymentGatewayTypeValue[];

// Backward compatibility alias
export const GATEWAY_TYPES = PAYMENT_GATEWAY_TYPE;
export const GATEWAY_TYPE_VALUES = PAYMENT_GATEWAY_TYPE_VALUES;

const paymentStatusSet = new Set<PaymentStatusValue>(PAYMENT_STATUS_VALUES);
const paymentGatewayTypeSet = new Set<PaymentGatewayTypeValue>(
  PAYMENT_GATEWAY_TYPE_VALUES,
);

export function isPaymentStatus(value: unknown): value is PaymentStatusValue {
  return typeof value === 'string' && paymentStatusSet.has(value as PaymentStatusValue);
}

export function isPaymentGatewayType(
  value: unknown,
): value is PaymentGatewayTypeValue {
  return (
    typeof value === 'string' &&
    paymentGatewayTypeSet.has(value as PaymentGatewayTypeValue)
  );
}

export const isGatewayType = isPaymentGatewayType;
