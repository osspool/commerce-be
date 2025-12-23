/**
 * Revenue Error Classes
 * @classytic/revenue
 *
 * Typed errors with codes for better error handling
 */

export interface RevenueErrorOptions {
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Base Revenue Error
 */
export class RevenueError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly metadata: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    options: RevenueErrorOptions = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.metadata = options.metadata ?? {};
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      metadata: this.metadata,
    };
  }
}

/**
 * Configuration Errors
 */
export class ConfigurationError extends RevenueError {
  constructor(message: string, metadata: Record<string, unknown> = {}) {
    super(message, 'CONFIGURATION_ERROR', { retryable: false, metadata });
  }
}

export class ModelNotRegisteredError extends ConfigurationError {
  constructor(modelName: string) {
    super(
      `Model "${modelName}" is not registered. Register it via createRevenue({ models: { ${modelName}: ... } })`,
      { modelName }
    );
  }
}

/**
 * Provider Errors
 */
export class ProviderError extends RevenueError {
  constructor(
    message: string,
    code: string,
    options: RevenueErrorOptions = {}
  ) {
    super(message, code, options);
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(providerName: string, availableProviders: string[] = []) {
    super(
      `Payment provider "${providerName}" not found. Available: ${availableProviders.join(', ')}`,
      'PROVIDER_NOT_FOUND',
      { retryable: false, metadata: { providerName, availableProviders } }
    );
  }
}

export class ProviderCapabilityError extends ProviderError {
  constructor(providerName: string, capability: string) {
    super(
      `Provider "${providerName}" does not support ${capability}`,
      'PROVIDER_CAPABILITY_NOT_SUPPORTED',
      { retryable: false, metadata: { providerName, capability } }
    );
  }
}

export class PaymentIntentCreationError extends ProviderError {
  constructor(providerName: string, originalError: Error) {
    super(
      `Failed to create payment intent with provider "${providerName}": ${originalError.message}`,
      'PAYMENT_INTENT_CREATION_FAILED',
      { retryable: true, metadata: { providerName, originalError: originalError.message } }
    );
  }
}

export class PaymentVerificationError extends ProviderError {
  constructor(paymentIntentId: string, reason: string) {
    super(
      `Payment verification failed for intent "${paymentIntentId}": ${reason}`,
      'PAYMENT_VERIFICATION_FAILED',
      { retryable: true, metadata: { paymentIntentId, reason } }
    );
  }
}

/**
 * Resource Not Found Errors
 */
export class NotFoundError extends RevenueError {
  constructor(
    message: string,
    code: string,
    metadata: Record<string, unknown> = {}
  ) {
    super(message, code, { retryable: false, metadata });
  }
}

export class SubscriptionNotFoundError extends NotFoundError {
  constructor(subscriptionId: string) {
    super(
      `Subscription not found: ${subscriptionId}`,
      'SUBSCRIPTION_NOT_FOUND',
      { subscriptionId }
    );
  }
}

export class TransactionNotFoundError extends NotFoundError {
  constructor(transactionId: string) {
    super(
      `Transaction not found: ${transactionId}`,
      'TRANSACTION_NOT_FOUND',
      { transactionId }
    );
  }
}

/**
 * Validation Errors
 */
export class ValidationError extends RevenueError {
  constructor(message: string, metadata: Record<string, unknown> = {}) {
    super(message, 'VALIDATION_ERROR', { retryable: false, metadata });
  }
}

export class InvalidAmountError extends ValidationError {
  constructor(amount: number, message?: string) {
    super(
      message ?? `Invalid amount: ${amount}. Amount must be non-negative`,
      { amount }
    );
  }
}

export class MissingRequiredFieldError extends ValidationError {
  constructor(fieldName: string) {
    super(`Missing required field: ${fieldName}`, { fieldName });
  }
}

/**
 * State Errors
 */
export class StateError extends RevenueError {
  constructor(
    message: string,
    code: string,
    metadata: Record<string, unknown> = {}
  ) {
    super(message, code, { retryable: false, metadata });
  }
}

export class AlreadyVerifiedError extends StateError {
  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} is already verified`,
      'ALREADY_VERIFIED',
      { transactionId }
    );
  }
}

export class InvalidStateTransitionError extends StateError {
  constructor(
    resourceType: string,
    resourceId: string,
    fromState: string,
    toState: string
  ) {
    super(
      `Invalid state transition for ${resourceType} ${resourceId}: ${fromState} → ${toState}`,
      'INVALID_STATE_TRANSITION',
      { resourceType, resourceId, fromState, toState }
    );
  }
}

export class SubscriptionNotActiveError extends StateError {
  constructor(subscriptionId: string, message?: string) {
    super(
      message ?? `Subscription ${subscriptionId} is not active`,
      'SUBSCRIPTION_NOT_ACTIVE',
      { subscriptionId }
    );
  }
}

/**
 * Operation Errors
 */
export class OperationError extends RevenueError {
  constructor(
    message: string,
    code: string,
    options: RevenueErrorOptions = {}
  ) {
    super(message, code, options);
  }
}

export class RefundNotSupportedError extends OperationError {
  constructor(providerName: string) {
    super(
      `Refunds are not supported by provider "${providerName}"`,
      'REFUND_NOT_SUPPORTED',
      { retryable: false, metadata: { providerName } }
    );
  }
}

export class RefundError extends OperationError {
  constructor(transactionId: string, reason: string) {
    super(
      `Refund failed for transaction ${transactionId}: ${reason}`,
      'REFUND_FAILED',
      { retryable: true, metadata: { transactionId, reason } }
    );
  }
}

/**
 * Error Code Constants
 */
export const ERROR_CODES = {
  // Configuration
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  MODEL_NOT_REGISTERED: 'MODEL_NOT_REGISTERED',

  // Provider
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_CAPABILITY_NOT_SUPPORTED: 'PROVIDER_CAPABILITY_NOT_SUPPORTED',
  PAYMENT_INTENT_CREATION_FAILED: 'PAYMENT_INTENT_CREATION_FAILED',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',

  // Not Found
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',

  // State
  ALREADY_VERIFIED: 'ALREADY_VERIFIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  SUBSCRIPTION_NOT_ACTIVE: 'SUBSCRIPTION_NOT_ACTIVE',

  // Operations
  REFUND_NOT_SUPPORTED: 'REFUND_NOT_SUPPORTED',
  REFUND_FAILED: 'REFUND_FAILED',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/**
 * Check if error is retryable
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof RevenueError && error.retryable;
}

/**
 * Check if error is from revenue package
 */
export function isRevenueError(error: unknown): error is RevenueError {
  return error instanceof RevenueError;
}

