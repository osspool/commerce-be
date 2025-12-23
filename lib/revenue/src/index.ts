/**
 * @classytic/revenue
 * Enterprise Revenue Management System
 *
 * Modern • Type-safe • Resilient • Composable
 *
 * @version 1.0.0
 * @author Classytic
 * @license MIT
 */

// ============ MAIN API ============
export {
  Revenue,
  RevenueBuilder,
  createRevenue,
  type RevenueOptions,
  type ModelsConfig,
  type ProvidersConfig,
  type HooksConfig,
} from './core/revenue.js';

// ============ CONTAINER (ADVANCED) ============
export { Container } from './core/container.js';

// ============ RESULT TYPE (RUST-INSPIRED) ============
export {
  Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  mapErr,
  flatMap,
  tryCatch,
  tryCatchSync,
  all,
  match,
  type Ok,
  type Err,
} from './core/result.js';

// ============ MONEY UTILITY ============
export {
  Money,
  toSmallestUnit,
  fromSmallestUnit,
  type MoneyValue,
} from './utils/money.js';

// ============ EVENT SYSTEM ============
export {
  EventBus,
  createEventBus,
  type RevenueEvents,
  type BaseEvent,
  type PaymentSucceededEvent,
  type PaymentFailedEvent,
  type PaymentRefundedEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionActivatedEvent,
  type SubscriptionRenewedEvent,
  type SubscriptionCancelledEvent,
  type TransactionCreatedEvent,
  type TransactionVerifiedEvent,
  type EscrowHeldEvent,
  type EscrowReleasedEvent,
} from './core/events.js';

// ============ PLUGIN SYSTEM ============
export {
  PluginManager,
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  definePlugin,
  type RevenuePlugin,
  type PluginContext,
  type PluginLogger,
  type PluginHooks,
} from './core/plugin.js';

// ============ VALIDATION (ZOD V4) ============
export {
  // Primitive schemas
  ObjectIdSchema,
  CurrencySchema,
  MoneyAmountSchema,
  MoneySchema,
  EmailSchema,
  IdempotencyKeySchema,
  MetadataSchema,
  // Payment schemas
  CreatePaymentSchema,
  VerifyPaymentSchema,
  RefundSchema,
  // Subscription schemas
  SubscriptionStatusSchema,
  IntervalSchema,
  CreateSubscriptionSchema,
  CancelSubscriptionSchema,
  // Monetization schemas
  MonetizationTypeSchema,
  CreateMonetizationSchema,
  // Commission schemas
  SplitRecipientSchema,
  CommissionConfigSchema,
  // Escrow schemas
  HoldStatusSchema,
  CreateHoldSchema,
  ReleaseHoldSchema,
  // Config schemas
  ProviderConfigSchema,
  RetryConfigSchema,
  RevenueConfigSchema,
  // Helpers
  validate,
  safeValidate,
  formatZodError,
  z,
  // Types
  type CreatePaymentInput,
  type VerifyPaymentInput,
  type RefundInput,
  type SubscriptionStatus,
  type Interval,
  type CreateSubscriptionInput,
  type CancelSubscriptionInput,
  type MonetizationType,
  type SplitRecipient,
  type CommissionConfig,
  type HoldStatus,
  type CreateHoldInput,
  type ReleaseHoldInput,
  type RetryConfig,
  type RevenueConfigInput,
} from './schemas/validation.js';

// ============ RESILIENCE UTILITIES ============
export {
  retry,
  retryWithResult,
  calculateDelay,
  isRetryableError,
  RetryExhaustedError,
  CircuitBreaker,
  createCircuitBreaker,
  CircuitOpenError,
  resilientExecute,
  type CircuitState,
  type CircuitBreakerConfig,
} from './utils/retry.js';

// ============ IDEMPOTENCY ============
export {
  IdempotencyManager,
  MemoryIdempotencyStore,
  IdempotencyError,
  createIdempotencyManager,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotencyConfig,
} from './utils/idempotency.js';

// ============ ERROR CLASSES ============
export * from './core/errors.js';

// ============ PROVIDER SYSTEM ============
export {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from './providers/base.js';

// ============ SERVICES (DIRECT ACCESS IF NEEDED) ============
export { MonetizationService } from './services/monetization.service.js';
export { PaymentService } from './services/payment.service.js';
export { TransactionService } from './services/transaction.service.js';
export { EscrowService } from './services/escrow.service.js';

// ============ ENUMS & MONGOOSE SCHEMAS ============
export * from './enums/index.js';
export * from './schemas/index.js';

// ============ UTILITIES ============
export {
  logger,
  setLogger,
  calculateCommission,
  reverseCommission,
  calculateSplits,
  calculateOrganizationPayout,
  reverseSplits,
  calculateCommissionWithSplits,
  resolveCategory,
  isCategoryValid,
  isMonetizationTransaction,
  isManualTransaction,
  getTransactionType,
  getAllowedUpdateFields,
  validateFieldUpdate,
  canSelfVerify,
  TRANSACTION_MANAGEMENT_TYPE,
  PROTECTED_MONETIZATION_FIELDS,
  EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION,
  MANUAL_TRANSACTION_CREATE_FIELDS,
  MANUAL_TRANSACTION_UPDATE_FIELDS,
  addDuration,
  calculatePeriodRange,
  calculateProratedAmount,
  resolveIntervalToDuration,
  isSubscriptionActive,
  canRenewSubscription,
  canCancelSubscription,
  canPauseSubscription,
  canResumeSubscription,
} from './utils/index.js';

// ============ TYPE EXPORTS ============
export type {
  // Core types
  ObjectId,
  MongooseDoc,
  MongooseModel,
  // Transaction types
  TransactionStatusValue,
  TransactionTypeValue,
  TransactionGateway,
  CommissionInfo,
  WebhookInfo,
  HoldInfo,
  ReleaseRecord,
  TransactionDocument,
  // Subscription types
  SubscriptionStatusValue,
  PlanKeyValue,
  SubscriptionDocument,
  // Payment types
  PaymentStatusValue,
  PaymentGatewayTypeValue,
  // Monetization types
  MonetizationTypeValue,
  // Escrow types
  HoldStatusValue,
  HoldReasonValue,
  ReleaseReasonValue,
  // Split types
  SplitTypeValue,
  SplitStatusValue,
  PayoutMethodValue,
  SplitRule,
  SplitInfo,
  // Provider types
  CreateIntentParams,
  PaymentIntentData,
  PaymentResultData,
  RefundResultData,
  WebhookEventData,
  ProviderCapabilities,
  PaymentProviderInterface,
  // Config types
  ModelsRegistry,
  ProvidersRegistry,
  HooksRegistry,
  Logger,
  RevenueConfig,
  CreateRevenueOptions,
  // Service param types
  MonetizationData,
  MonetizationCreateParams,
  MonetizationCreateResult,
  ActivateOptions,
  RenewalParams,
  CancelOptions,
  PauseOptions,
  ResumeOptions,
  ListOptions,
  PaymentVerifyOptions,
  PaymentVerifyResult,
  PaymentStatusResult,
  RefundOptions,
  PaymentRefundResult,
  WebhookResult,
  TransactionListResult,
  HoldOptions,
  ReleaseOptions,
  ReleaseResult,
  CancelHoldOptions,
  SplitResult,
  EscrowStatusResult,
  // Utility types
  PeriodRangeParams,
  PeriodRangeResult,
  ProratedAmountParams,
  DurationResult,
  SubscriptionEntity,
  CommissionWithSplitsOptions,
  TransactionTypeOptions,
  FieldUpdateValidationResult,
} from './types/index.js';

// ============ DEFAULT EXPORT ============
import { Revenue, createRevenue } from './core/revenue.js';
import { PaymentProvider } from './providers/base.js';
import { RevenueError } from './core/errors.js';
import { Money } from './utils/money.js';
import { Result } from './core/result.js';
import { EventBus } from './core/events.js';

export default {
  Revenue,
  createRevenue,
  PaymentProvider,
  RevenueError,
  Money,
  Result,
  EventBus,
};
