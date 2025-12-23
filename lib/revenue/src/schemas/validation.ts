/**
 * Zod Validation Schemas
 * @classytic/revenue
 *
 * Runtime validation with TypeScript inference
 * Using Zod v4 - Modern schema validation
 *
 * Inspired by: tRPC, Zod best practices
 */

import * as z from 'zod';

// ============ PRIMITIVE SCHEMAS ============

/**
 * MongoDB ObjectId pattern
 */
export const ObjectIdSchema = z.string().regex(
  /^[a-fA-F0-9]{24}$/,
  'Invalid ObjectId format'
);

/**
 * Currency code (ISO 4217)
 */
export const CurrencySchema = z.string()
  .length(3, 'Currency must be 3 characters')
  .transform(val => val.toUpperCase())
  .default('USD');

/**
 * Money amount in smallest unit (cents, paisa)
 */
export const MoneyAmountSchema = z.number()
  .int('Amount must be integer (smallest unit)')
  .nonnegative('Amount cannot be negative');

/**
 * Money object
 */
export const MoneySchema = z.object({
  amount: MoneyAmountSchema,
  currency: z.string().length(3).default('USD'),
});

/**
 * Email address
 */
export const EmailSchema = z.string().email();

/**
 * Idempotency key (optional, auto-generated if not provided)
 */
export const IdempotencyKeySchema = z.string()
  .min(1)
  .max(255)
  .optional();

/**
 * Metadata object - Zod v4 record syntax
 */
export const MetadataSchema = z.record(z.string(), z.unknown()).optional().default({});

// ============ PAYMENT SCHEMAS ============

/**
 * Create payment intent params
 */
export const CreatePaymentSchema = z.object({
  /** Amount in smallest currency unit (cents) */
  amount: MoneyAmountSchema,
  /** ISO 4217 currency code */
  currency: z.string().length(3).default('USD'),
  /** Customer identifier */
  customerId: z.string().min(1, 'Customer ID is required'),
  /** Organization/merchant identifier */
  organizationId: z.string().min(1, 'Organization ID is required'),
  /** Payment provider to use */
  provider: z.string().min(1, 'Provider is required'),
  /** Idempotency key for safe retries */
  idempotencyKey: IdempotencyKeySchema,
  /** Description of the payment */
  description: z.string().optional(),
  /** Additional metadata */
  metadata: MetadataSchema,
  /** Success redirect URL */
  successUrl: z.string().url().optional(),
  /** Cancel redirect URL */
  cancelUrl: z.string().url().optional(),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

/**
 * Verify payment params
 */
export const VerifyPaymentSchema = z.object({
  /** Transaction ID or payment intent ID */
  id: z.string().min(1),
  /** Provider name (optional, auto-detected) */
  provider: z.string().optional(),
  /** Additional verification data */
  data: z.record(z.string(), z.unknown()).optional(),
});

export type VerifyPaymentInput = z.infer<typeof VerifyPaymentSchema>;

/**
 * Refund params
 */
export const RefundSchema = z.object({
  /** Transaction ID to refund */
  transactionId: z.string().min(1),
  /** Amount to refund (optional, full refund if not provided) */
  amount: MoneyAmountSchema.optional(),
  /** Reason for refund */
  reason: z.string().optional(),
  /** Idempotency key */
  idempotencyKey: IdempotencyKeySchema,
  /** Additional metadata */
  metadata: MetadataSchema,
});

export type RefundInput = z.infer<typeof RefundSchema>;

// ============ SUBSCRIPTION SCHEMAS ============

/**
 * Subscription status
 */
export const SubscriptionStatusSchema = z.enum([
  'pending',
  'active',
  'paused',
  'cancelled',
  'expired',
  'past_due',
]);

export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

/**
 * Subscription interval
 */
export const IntervalSchema = z.enum([
  'day',
  'week',
  'month',
  'year',
  'one_time',
]);

export type Interval = z.infer<typeof IntervalSchema>;

/**
 * Create subscription params
 */
export const CreateSubscriptionSchema = z.object({
  /** Customer ID */
  customerId: z.string().min(1),
  /** Organization ID */
  organizationId: z.string().min(1),
  /** Plan identifier */
  planKey: z.string().min(1),
  /** Amount per period (smallest unit) */
  amount: MoneyAmountSchema,
  /** Currency */
  currency: z.string().length(3).default('USD'),
  /** Billing interval */
  interval: IntervalSchema.default('month'),
  /** Interval count (e.g., 2 for bi-monthly) */
  intervalCount: z.number().int().positive().default(1),
  /** Payment provider */
  provider: z.string().min(1),
  /** Reference to external entity */
  referenceId: z.string().optional(),
  /** Reference model name */
  referenceModel: z.string().optional(),
  /** Idempotency key */
  idempotencyKey: IdempotencyKeySchema,
  /** Metadata */
  metadata: MetadataSchema,
  /** Trial period in days */
  trialDays: z.number().int().nonnegative().optional(),
});

export type CreateSubscriptionInput = z.infer<typeof CreateSubscriptionSchema>;

/**
 * Cancel subscription params
 */
export const CancelSubscriptionSchema = z.object({
  /** Subscription ID */
  subscriptionId: z.string().min(1),
  /** Cancel immediately or at period end */
  immediate: z.boolean().default(false),
  /** Cancellation reason */
  reason: z.string().optional(),
});

export type CancelSubscriptionInput = z.infer<typeof CancelSubscriptionSchema>;

// ============ MONETIZATION SCHEMAS ============

/**
 * Monetization type
 */
export const MonetizationTypeSchema = z.enum([
  'purchase',
  'subscription',
  'free',
]);

export type MonetizationType = z.infer<typeof MonetizationTypeSchema>;

/**
 * Create monetization params (unified API)
 */
export const CreateMonetizationSchema = z.object({
  /** Type of monetization */
  type: MonetizationTypeSchema.default('purchase'),
  /** Amount (smallest unit) - required for purchase/subscription */
  amount: MoneyAmountSchema.optional(),
  /** Currency */
  currency: z.string().length(3).default('USD'),
  /** Customer ID */
  customerId: z.string().min(1),
  /** Organization ID */
  organizationId: z.string().min(1),
  /** Payment provider */
  provider: z.string().min(1),
  /** Plan key for categorization */
  planKey: z.string().optional(),
  /** Reference ID */
  referenceId: z.string().optional(),
  /** Reference model */
  referenceModel: z.string().optional(),
  /** Idempotency key */
  idempotencyKey: IdempotencyKeySchema,
  /** Metadata */
  metadata: MetadataSchema,
  /** Subscription-specific: interval */
  interval: IntervalSchema.optional(),
  /** Subscription-specific: trial days */
  trialDays: z.number().int().nonnegative().optional(),
}).refine(
  (data) => {
    if (data.type !== 'free' && !data.amount) {
      return false;
    }
    return true;
  },
  { message: 'Amount is required for non-free monetization types' }
);

export type CreateMonetizationInput = z.infer<typeof CreateMonetizationSchema>;

// ============ COMMISSION SCHEMAS ============

/**
 * Commission split recipient
 */
export const SplitRecipientSchema = z.object({
  /** Recipient ID */
  recipientId: z.string().min(1),
  /** Recipient type (user, organization, etc.) */
  recipientType: z.string().default('user'),
  /** Percentage of net amount (0-100) */
  percentage: z.number().min(0).max(100),
  /** Role description */
  role: z.string().optional(),
});

export type SplitRecipient = z.infer<typeof SplitRecipientSchema>;

/**
 * Commission configuration
 */
export const CommissionConfigSchema = z.object({
  /** Platform commission rate (0-100) */
  platformRate: z.number().min(0).max(100).default(0),
  /** Gateway fee rate (0-100) */
  gatewayFeeRate: z.number().min(0).max(100).default(0),
  /** Fixed gateway fee (smallest unit) */
  gatewayFixedFee: MoneyAmountSchema.default(0),
  /** Split recipients */
  splits: z.array(SplitRecipientSchema).optional(),
  /** Affiliate configuration */
  affiliate: z.object({
    recipientId: z.string(),
    recipientType: z.string().default('user'),
    rate: z.number().min(0).max(100),
  }).optional(),
});

export type CommissionConfig = z.infer<typeof CommissionConfigSchema>;

// ============ ESCROW SCHEMAS ============

/**
 * Hold status
 */
export const HoldStatusSchema = z.enum([
  'none',
  'held',
  'partial_release',
  'released',
  'cancelled',
]);

export type HoldStatus = z.infer<typeof HoldStatusSchema>;

/**
 * Create hold params
 */
export const CreateHoldSchema = z.object({
  /** Transaction ID */
  transactionId: z.string().min(1),
  /** Hold amount (optional, defaults to full transaction amount) */
  amount: MoneyAmountSchema.optional(),
  /** Hold until date */
  holdUntil: z.date().optional(),
  /** Reason for hold */
  reason: z.string().optional(),
});

export type CreateHoldInput = z.infer<typeof CreateHoldSchema>;

/**
 * Release hold params
 */
export const ReleaseHoldSchema = z.object({
  /** Transaction ID */
  transactionId: z.string().min(1),
  /** Amount to release (optional, full release if not provided) */
  amount: MoneyAmountSchema.optional(),
  /** Recipient ID */
  recipientId: z.string().min(1),
  /** Recipient type */
  recipientType: z.string().default('user'),
  /** Release notes */
  notes: z.string().optional(),
});

export type ReleaseHoldInput = z.infer<typeof ReleaseHoldSchema>;

// ============ CONFIG SCHEMAS ============

/**
 * Provider configuration
 */
export const ProviderConfigSchema = z.record(z.string(), z.unknown());

/**
 * Retry configuration
 */
export const RetryConfigSchema = z.object({
  /** Maximum retry attempts */
  maxAttempts: z.number().int().positive().default(3),
  /** Base delay in ms */
  baseDelay: z.number().positive().default(1000),
  /** Maximum delay in ms */
  maxDelay: z.number().positive().default(30000),
  /** Backoff multiplier */
  backoffMultiplier: z.number().positive().default(2),
  /** Jitter factor (0-1) */
  jitter: z.number().min(0).max(1).default(0.1),
});

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/**
 * Revenue configuration
 */
export const RevenueConfigSchema = z.object({
  /** Default currency */
  defaultCurrency: z.string().length(3).default('USD'),
  /** Commission configuration */
  commission: CommissionConfigSchema.optional(),
  /** Retry configuration */
  retry: RetryConfigSchema.optional(),
  /** Enable debug logging */
  debug: z.boolean().default(false),
  /** Environment */
  environment: z.enum(['development', 'staging', 'production']).default('development'),
});

export type RevenueConfigInput = z.infer<typeof RevenueConfigSchema>;

// ============ VALIDATION HELPERS ============

/**
 * Validate input against schema
 */
export function validate<T extends z.ZodType>(
  schema: T,
  data: unknown
): z.infer<T> {
  return schema.parse(data);
}

/**
 * Safe validate (returns result, doesn't throw)
 */
export function safeValidate<T extends z.ZodType>(
  schema: T,
  data: unknown
): { success: true; data: z.infer<T> } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Format Zod error for display
 * Zod v4 uses `issues` property
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
}

export { z };
