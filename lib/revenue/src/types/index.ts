/**
 * @classytic/revenue - Core Type Definitions
 * Enterprise Revenue Management System
 *
 * @module @classytic/revenue/types
 */

import type { Document, Types } from 'mongoose';

// ============ MONGOOSE TYPES ============

/** Generic Mongoose document type */
export type MongooseDoc<T = unknown> = Document & T;

/** ObjectId type from Mongoose */
export type ObjectId = Types.ObjectId;

/** Generic Mongoose model interface - simplified for compatibility */
export interface MongooseModel<T = unknown> {
  findById(id: string | ObjectId): Promise<T | null>;
  find(filter?: object): unknown; // Returns query chain
  findOne(filter?: object): Promise<T | null>;
  create(data: Partial<T> | Record<string, unknown>): Promise<T>;
  countDocuments?(filter?: object): Promise<number>;
  count?(filter?: object): Promise<number>;
  findByIdAndUpdate(
    id: string | ObjectId,
    update: object,
    options?: object
  ): Promise<T | null>;
  update?(id: string, data: object): Promise<T | null>;
}

// ============ TRANSACTION TYPES ============

/** Transaction status values */
export type TransactionStatusValue =
  | 'pending'
  | 'payment_initiated'
  | 'processing'
  | 'requires_action'
  | 'verified'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

/** Transaction type values */
export type TransactionTypeValue = 'income' | 'expense';

/** Gateway information stored on transaction */
export interface TransactionGateway {
  type: string;
  sessionId?: string | null;
  paymentIntentId?: string | null;
  provider?: string;
  metadata?: Record<string, unknown>;
  verificationData?: Record<string, unknown>;
}

/** Commission information */
export interface CommissionInfo {
  rate: number;
  grossAmount: number;
  gatewayFeeRate: number;
  gatewayFeeAmount: number;
  netAmount: number;
  status: 'pending' | 'paid' | 'waived';
  splits?: SplitInfo[];
  affiliate?: {
    recipientId: string;
    recipientType: string;
    rate: number;
    grossAmount: number;
    netAmount: number;
  };
}

/** Webhook information */
export interface WebhookInfo {
  eventId: string;
  eventType: string;
  receivedAt: Date;
  processedAt?: Date;
  data: Record<string, unknown>;
}

/** Hold (escrow) information */
export interface HoldInfo {
  status: HoldStatusValue;
  heldAmount: number;
  releasedAmount: number;
  reason?: HoldReasonValue;
  holdUntil?: Date | null;
  heldAt?: Date;
  releasedAt?: Date;
  cancelledAt?: Date;
  releases: ReleaseRecord[];
  metadata: Record<string, unknown>;
}

/** Release record for escrow */
export interface ReleaseRecord {
  amount: number;
  recipientId: string;
  recipientType: string;
  releasedAt: Date;
  releasedBy?: string | null;
  reason: string;
  metadata: Record<string, unknown>;
}

/** Base transaction document interface */
export interface TransactionDocument {
  _id: ObjectId;
  organizationId?: string | ObjectId;
  customerId?: string | ObjectId | null;
  amount: number;
  currency: string;
  category: string;
  type: TransactionTypeValue;
  method: string;
  status: TransactionStatusValue;
  gateway?: TransactionGateway;
  paymentDetails?: Record<string, unknown>;
  commission?: CommissionInfo | null;
  referenceId?: string | ObjectId;
  referenceModel?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  verifiedAt?: Date;
  verifiedBy?: string | ObjectId | null;
  failureReason?: string;
  refundedAmount?: number;
  refundedAt?: Date;
  webhook?: WebhookInfo;
  hold?: HoldInfo;
  splits?: SplitInfo[];
  createdAt: Date;
  updatedAt: Date;
  save(): Promise<this>;
}

// ============ SUBSCRIPTION TYPES ============

/** Subscription status values */
export type SubscriptionStatusValue =
  | 'active'
  | 'paused'
  | 'cancelled'
  | 'expired'
  | 'pending'
  | 'inactive'
  | 'pending_renewal';

/** Plan key values */
export type PlanKeyValue = 'monthly' | 'quarterly' | 'yearly' | string;

/** Base subscription document interface */
export interface SubscriptionDocument {
  _id: ObjectId;
  organizationId?: string | ObjectId;
  customerId?: string | ObjectId | null;
  planKey: PlanKeyValue;
  amount: number;
  currency: string;
  status: SubscriptionStatusValue;
  isActive: boolean;
  gateway?: string;
  transactionId?: ObjectId | null;
  paymentIntentId?: string | null;
  startDate?: Date;
  endDate?: Date;
  activatedAt?: Date;
  canceledAt?: Date;
  cancelAt?: Date;
  cancellationReason?: string | null;
  pausedAt?: Date | null;
  pauseReason?: string | null;
  renewalCount?: number;
  renewalTransactionId?: ObjectId;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  save(): Promise<this>;
}

// ============ PAYMENT TYPES ============

/** Payment status values */
export type PaymentStatusValue =
  | 'pending'
  | 'verified'
  | 'failed'
  | 'refunded'
  | 'cancelled';

/** Payment gateway type values */
export type PaymentGatewayTypeValue = 'manual' | 'stripe' | 'sslcommerz' | string;

// ============ MONETIZATION TYPES ============

/** Monetization type values */
export type MonetizationTypeValue = 'free' | 'purchase' | 'subscription';

// ============ ESCROW/HOLD TYPES ============

/** Hold status values */
export type HoldStatusValue =
  | 'pending'
  | 'held'
  | 'released'
  | 'cancelled'
  | 'expired'
  | 'partially_released';

/** Hold reason values */
export type HoldReasonValue =
  | 'payment_verification'
  | 'fraud_check'
  | 'manual_review'
  | 'dispute'
  | 'compliance';

/** Release reason values */
export type ReleaseReasonValue =
  | 'payment_verified'
  | 'manual_release'
  | 'auto_release'
  | 'dispute_resolved';

// ============ SPLIT TYPES ============

/** Split type values */
export type SplitTypeValue =
  | 'platform_commission'
  | 'affiliate_commission'
  | 'referral_commission'
  | 'partner_commission'
  | 'custom';

/** Split status values */
export type SplitStatusValue = 'pending' | 'due' | 'paid' | 'waived' | 'cancelled';

/** Payout method values */
export type PayoutMethodValue =
  | 'bank_transfer'
  | 'mobile_wallet'
  | 'platform_balance'
  | 'crypto'
  | 'check'
  | 'manual';

/** Split rule configuration */
export interface SplitRule {
  type?: SplitTypeValue;
  recipientId: string;
  recipientType: string;
  rate: number;
  dueDate?: Date | null;
  metadata?: Record<string, unknown>;
}

/** Calculated split info */
export interface SplitInfo {
  type: SplitTypeValue;
  recipientId: string;
  recipientType: string;
  rate: number;
  grossAmount: number;
  gatewayFeeRate: number;
  gatewayFeeAmount: number;
  netAmount: number;
  status: SplitStatusValue;
  dueDate?: Date | null;
  paidDate?: Date;
  payoutTransactionId?: string;
  metadata: Record<string, unknown>;
}

// ============ PROVIDER TYPES ============

/** Payment intent parameters */
export interface CreateIntentParams {
  amount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

/** Payment intent data */
export interface PaymentIntentData {
  id: string;
  sessionId?: string | null;
  paymentIntentId?: string | null;
  provider: string;
  status: string;
  amount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  clientSecret?: string;
  paymentUrl?: string;
  instructions?: string;
  raw?: unknown;
}

/** Payment result data */
export interface PaymentResultData {
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing';
  amount?: number;
  currency?: string;
  paidAt?: Date;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/** Refund result data */
export interface RefundResultData {
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing';
  amount?: number;
  currency?: string;
  refundedAt?: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/** Webhook event data */
export interface WebhookEventData {
  id: string;
  provider: string;
  type: string;
  data: {
    sessionId?: string;
    paymentIntentId?: string;
    [key: string]: unknown;
  };
  createdAt?: Date;
  raw?: unknown;
}

/** Provider capabilities */
export interface ProviderCapabilities {
  supportsWebhooks: boolean;
  supportsRefunds: boolean;
  supportsPartialRefunds: boolean;
  requiresManualVerification: boolean;
}

// ============ SERVICE TYPES ============

/** Models registry */
export interface ModelsRegistry {
  Transaction: MongooseModel<TransactionDocument>;
  Subscription?: MongooseModel<SubscriptionDocument>;
}

/** Provider registry */
export interface ProvidersRegistry {
  [name: string]: PaymentProviderInterface;
}

/** Hook handlers registry */
export interface HooksRegistry {
  [event: string]: Array<(data: unknown) => void | Promise<void>>;
}

/** Logger interface */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  log?(...args: unknown[]): void;
}

/** Revenue configuration */
export interface RevenueConfig {
  targetModels: string[];
  categoryMappings: Record<string, string>;
  commissionRates?: Record<string, number>;
  gatewayFeeRates?: Record<string, number>;
  transactionTypeMapping?: Record<string, TransactionTypeValue>;
}

/** Create revenue options */
export interface CreateRevenueOptions {
  models: ModelsRegistry;
  providers?: ProvidersRegistry;
  hooks?: HooksRegistry;
  config?: Partial<RevenueConfig>;
  logger?: Logger;
}

/** Payment provider interface */
export interface PaymentProviderInterface {
  name: string;
  config: Record<string, unknown>;
  createIntent(params: CreateIntentParams): Promise<PaymentIntentData>;
  verifyPayment(intentId: string): Promise<PaymentResultData>;
  getStatus(intentId: string): Promise<PaymentResultData>;
  refund(
    paymentId: string,
    amount?: number | null,
    options?: { reason?: string }
  ): Promise<RefundResultData>;
  handleWebhook(
    payload: unknown,
    headers?: Record<string, string>
  ): Promise<WebhookEventData>;
  verifyWebhookSignature(payload: unknown, signature: string): boolean;
  getCapabilities(): ProviderCapabilities;
}

// ============ MONETIZATION SERVICE TYPES ============

/** Monetization create data */
export interface MonetizationData {
  organizationId?: string | ObjectId;
  customerId?: string | ObjectId;
  referenceId?: string | ObjectId;
  referenceModel?: string;
}

/** Monetization create params */
export interface MonetizationCreateParams {
  data: MonetizationData;
  planKey: string;
  amount: number;
  currency?: string;
  gateway?: string;
  entity?: string | null;
  monetizationType?: MonetizationTypeValue;
  paymentData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

/** Monetization create result */
export interface MonetizationCreateResult {
  subscription: SubscriptionDocument | null;
  transaction: TransactionDocument | null;
  paymentIntent: PaymentIntentData | null;
}

/** Activation options */
export interface ActivateOptions {
  timestamp?: Date;
}

/** Renewal params */
export interface RenewalParams {
  gateway?: string;
  entity?: string | null;
  paymentData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

/** Cancellation options */
export interface CancelOptions {
  immediate?: boolean;
  reason?: string | null;
}

/** Pause options */
export interface PauseOptions {
  reason?: string | null;
}

/** Resume options */
export interface ResumeOptions {
  extendPeriod?: boolean;
}

/** List options */
export interface ListOptions {
  limit?: number;
  skip?: number;
  page?: number | null;
  sort?: Record<string, 1 | -1>;
  populate?: string[];
}

// ============ PAYMENT SERVICE TYPES ============

/** Payment verify options */
export interface PaymentVerifyOptions {
  verifiedBy?: string | null;
}

/** Payment verify result */
export interface PaymentVerifyResult {
  transaction: TransactionDocument;
  paymentResult: PaymentResultData | null;
  status: TransactionStatusValue;
}

/** Payment status result */
export interface PaymentStatusResult {
  transaction: TransactionDocument;
  paymentResult?: PaymentResultData | null;
  status: TransactionStatusValue | string;
  provider?: string;
}

/** Refund options */
export interface RefundOptions {
  reason?: string | null;
}

/** Payment refund result */
export interface PaymentRefundResult {
  transaction: TransactionDocument;
  refundTransaction: TransactionDocument;
  refundResult: RefundResultData;
  status: TransactionStatusValue;
}

/** Webhook result */
export interface WebhookResult {
  event: WebhookEventData;
  transaction: TransactionDocument;
  status: 'processed' | 'already_processed';
}

// ============ TRANSACTION SERVICE TYPES ============

/** Transaction list result */
export interface TransactionListResult {
  transactions: TransactionDocument[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// ============ ESCROW SERVICE TYPES ============

/** Hold options */
export interface HoldOptions {
  reason?: HoldReasonValue;
  holdUntil?: Date | null;
  metadata?: Record<string, unknown>;
}

/** Release options */
export interface ReleaseOptions {
  amount?: number | null;
  recipientId: string;
  recipientType?: string;
  reason?: ReleaseReasonValue;
  releasedBy?: string | null;
  createTransaction?: boolean;
  metadata?: Record<string, unknown>;
}

/** Release result */
export interface ReleaseResult {
  transaction: TransactionDocument;
  releaseTransaction: TransactionDocument | null;
  releaseAmount: number;
  isFullRelease: boolean;
  isPartialRelease: boolean;
}

/** Cancel hold options */
export interface CancelHoldOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Split result */
export interface SplitResult {
  transaction: TransactionDocument;
  splits: SplitInfo[];
  splitTransactions: TransactionDocument[];
  organizationTransaction: TransactionDocument | null;
  organizationPayout: number;
}

/** Escrow status result */
export interface EscrowStatusResult {
  transaction: TransactionDocument;
  hold: HoldInfo | null;
  splits: SplitInfo[];
  hasHold: boolean;
  hasSplits: boolean;
}

// ============ SUBSCRIPTION UTILITIES ============

/** Period range params */
export interface PeriodRangeParams {
  currentEndDate?: Date | null;
  startDate?: Date | null;
  duration: number;
  unit?: 'days' | 'weeks' | 'months' | 'years';
  now?: Date;
}

/** Period range result */
export interface PeriodRangeResult {
  startDate: Date;
  endDate: Date;
}

/** Prorated amount params */
export interface ProratedAmountParams {
  amountPaid: number;
  startDate: Date;
  endDate: Date;
  asOfDate?: Date;
  precision?: number;
}

/** Duration result */
export interface DurationResult {
  duration: number;
  unit: 'days' | 'weeks' | 'months' | 'years';
}

/** Subscription entity for action checks */
export interface SubscriptionEntity {
  subscription?: {
    isActive?: boolean;
    endDate?: Date;
    canceledAt?: Date;
  };
  status?: SubscriptionStatusValue;
}

// ============ COMMISSION UTILITIES ============

/** Commission with splits options */
export interface CommissionWithSplitsOptions {
  affiliateRate?: number;
  affiliateId?: string | null;
  affiliateType?: string;
}

// ============ TRANSACTION TYPE UTILITIES ============

/** Transaction type detection options */
export interface TransactionTypeOptions {
  targetModels?: string[];
  additionalCategories?: string[];
}

/** Field update validation result */
export interface FieldUpdateValidationResult {
  allowed: boolean;
  reason?: string;
}

