/**
 * Retry Utilities
 * @classytic/revenue
 *
 * Exponential backoff with jitter for resilient operations
 * Inspired by: AWS SDK retry, Netflix Hystrix, resilience4j
 */

import { Result, ok, err } from '../core/result.js';

// ============ TYPES ============

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelay: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitter: number;
  /** Which errors are retryable */
  retryIf?: (error: unknown) => boolean;
  /** Callback on each retry */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

export interface RetryState {
  attempt: number;
  totalDelay: number;
  errors: Error[];
}

// ============ DEFAULT CONFIG ============

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: 0.1,
  retryIf: isRetryableError,
};

// ============ RETRY LOGIC ============

/**
 * Calculate delay with exponential backoff and jitter
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig
): number {
  // Exponential backoff: baseDelay * multiplier^attempt
  const exponentialDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt);
  
  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);
  
  // Add jitter (random variance)
  const jitterRange = cappedDelay * config.jitter;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;
  
  return Math.round(Math.max(0, cappedDelay + jitter));
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable by default
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Network errors
  if (error.message.includes('ECONNREFUSED')) return true;
  if (error.message.includes('ETIMEDOUT')) return true;
  if (error.message.includes('ENOTFOUND')) return true;
  if (error.message.includes('network')) return true;
  if (error.message.includes('timeout')) return true;

  // Rate limiting
  if (error.message.includes('429')) return true;
  if (error.message.includes('rate limit')) return true;

  // Server errors (5xx)
  if (error.message.includes('500')) return true;
  if (error.message.includes('502')) return true;
  if (error.message.includes('503')) return true;
  if (error.message.includes('504')) return true;

  // Check for retryable property
  if ('retryable' in error && (error as any).retryable === true) return true;

  return false;
}

/**
 * Execute operation with retry logic
 */
export async function retry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const fullConfig: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  const state: RetryState = {
    attempt: 0,
    totalDelay: 0,
    errors: [],
  };

  while (state.attempt < fullConfig.maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      state.errors.push(error instanceof Error ? error : new Error(String(error)));
      state.attempt++;

      // Check if we should retry
      const shouldRetry = fullConfig.retryIf?.(error) ?? isRetryableError(error);
      
      if (!shouldRetry || state.attempt >= fullConfig.maxAttempts) {
        throw new RetryExhaustedError(
          `Operation failed after ${state.attempt} attempts`,
          state.errors
        );
      }

      // Calculate delay
      const delay = calculateDelay(state.attempt - 1, fullConfig);
      state.totalDelay += delay;

      // Callback
      fullConfig.onRetry?.(error, state.attempt, delay);

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new RetryExhaustedError(
    `Operation failed after ${state.attempt} attempts`,
    state.errors
  );
}

/**
 * Execute operation with retry, returning Result instead of throwing
 */
export async function retryWithResult<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<Result<T, RetryExhaustedError>> {
  try {
    const result = await retry(operation, config);
    return ok(result);
  } catch (error) {
    if (error instanceof RetryExhaustedError) {
      return err(error);
    }
    return err(new RetryExhaustedError('Operation failed', [
      error instanceof Error ? error : new Error(String(error))
    ]));
  }
}

// ============ ERROR CLASSES ============

/**
 * Error thrown when all retries are exhausted
 */
export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly errors: Error[];

  constructor(message: string, errors: Error[]) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = errors.length;
    this.errors = errors;
  }

  /**
   * Get the last error
   */
  get lastError(): Error | undefined {
    return this.errors[this.errors.length - 1];
  }

  /**
   * Get the first error
   */
  get firstError(): Error | undefined {
    return this.errors[0];
  }
}

// ============ CIRCUIT BREAKER ============

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms to wait before half-opening */
  resetTimeout: number;
  /** Number of successes in half-open to close circuit */
  successThreshold: number;
  /** Monitor window in ms */
  monitorWindow: number;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 30000,
  successThreshold: 3,
  monitorWindow: 60000,
};

/**
 * Circuit breaker for preventing cascade failures
 * Inspired by: Netflix Hystrix, resilience4j
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: Date[] = [];
  private successes = 0;
  private lastFailure?: Date;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  /**
   * Execute operation through circuit breaker
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check circuit state
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.state = 'half-open';
      } else {
        throw new CircuitOpenError('Circuit is open, request rejected');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Execute with Result type
   */
  async executeWithResult<T>(
    operation: () => Promise<T>
  ): Promise<Result<T, CircuitOpenError | Error>> {
    try {
      const result = await this.execute(operation);
      return ok(result);
    } catch (error) {
      return err(error as Error);
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.reset();
      }
    }
    // Clean old failures outside monitor window
    this.cleanOldFailures();
  }

  private onFailure(): void {
    this.failures.push(new Date());
    this.lastFailure = new Date();
    this.successes = 0;

    // Clean old failures
    this.cleanOldFailures();

    // Check if we should open circuit
    if (this.failures.length >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailure) return true;
    return Date.now() - this.lastFailure.getTime() >= this.config.resetTimeout;
  }

  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.config.monitorWindow;
    this.failures = this.failures.filter(f => f.getTime() > cutoff);
  }

  private reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.successes = 0;
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Manually reset circuit
   */
  forceReset(): void {
    this.reset();
  }

  /**
   * Get circuit statistics
   */
  getStats(): {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailure?: Date;
  } {
    return {
      state: this.state,
      failures: this.failures.length,
      successes: this.successes,
      lastFailure: this.lastFailure,
    };
  }
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Create a circuit breaker
 */
export function createCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(config);
}

// ============ COMBINED RETRY WITH CIRCUIT BREAKER ============

/**
 * Execute with both retry and circuit breaker
 */
export async function resilientExecute<T>(
  operation: () => Promise<T>,
  options: {
    retry?: Partial<RetryConfig>;
    circuitBreaker?: CircuitBreaker;
  } = {}
): Promise<T> {
  const { retry: retryConfig, circuitBreaker } = options;

  const wrappedOperation = async () => {
    if (circuitBreaker) {
      return circuitBreaker.execute(operation);
    }
    return operation();
  };

  if (retryConfig) {
    return retry(wrappedOperation, retryConfig);
  }

  return wrappedOperation();
}

export default retry;

