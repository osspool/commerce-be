/**
 * BD Logistics SDK Error Classes
 */

/**
 * Base error class for logistics SDK
 */
export class LogisticsError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LogisticsError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Provider not found or not supported
 */
export class ProviderNotFoundError extends LogisticsError {
  constructor(providerName: string) {
    super(
      `Unknown logistics provider: ${providerName}`,
      'PROVIDER_NOT_FOUND',
      { provider: providerName }
    );
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * Provider API error (HTTP errors, validation errors)
 */
export class ProviderAPIError extends LogisticsError {
  status: number;
  body: string | null;

  constructor(provider: string, status: number, message: string, body: string | null = null) {
    super(
      `${provider} API error: ${status} - ${message}`,
      'PROVIDER_API_ERROR',
      { provider, status, body }
    );
    this.name = 'ProviderAPIError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Validation error for shipment creation
 */
export class ValidationError extends LogisticsError {
  errors: string[];

  constructor(errors: string[], context: Record<string, unknown> = {}) {
    const message = [
      'Shipment validation failed:',
      ...errors.map(err => `  - ${err}`),
    ].join('\n');

    super(message, 'VALIDATION_ERROR', { errors, context });
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Circuit breaker is open - provider temporarily unavailable
 */
export class CircuitOpenError extends LogisticsError {
  constructor(provider: string, status: Record<string, unknown>) {
    super(
      `Circuit breaker OPEN for ${provider}. Service is temporarily unavailable.`,
      'CIRCUIT_OPEN',
      { provider, status }
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Request timeout
 */
export class TimeoutError extends LogisticsError {
  constructor(provider: string, timeout: number) {
    super(
      `Request to ${provider} timed out after ${timeout}ms`,
      'TIMEOUT',
      { provider, timeout }
    );
    this.name = 'TimeoutError';
  }
}
