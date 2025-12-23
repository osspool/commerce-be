/**
 * Core Module Exports
 * @classytic/revenue
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
} from './revenue.js';

export { Container } from './container.js';

// ============ RESULT TYPE ============
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
} from './result.js';

// ============ EVENT SYSTEM ============
export {
  EventBus,
  createEventBus,
  type RevenueEvents,
  type BaseEvent,
  type PaymentSucceededEvent,
  type PaymentFailedEvent,
  type PaymentRefundedEvent,
  type PaymentInitiatedEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionActivatedEvent,
  type SubscriptionRenewedEvent,
  type SubscriptionCancelledEvent,
  type SubscriptionPausedEvent,
  type SubscriptionResumedEvent,
  type SubscriptionExpiredEvent,
  type TransactionCreatedEvent,
  type TransactionVerifiedEvent,
  type TransactionCompletedEvent,
  type TransactionFailedEvent,
  type EscrowHeldEvent,
  type EscrowReleasedEvent,
  type EscrowCancelledEvent,
  type CommissionCalculatedEvent,
  type CommissionPaidEvent,
  type WebhookReceivedEvent,
  type WebhookProcessedEvent,
} from './events.js';

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
  type HookFn,
} from './plugin.js';

// ============ ERRORS ============
export * from './errors.js';
