/**
 * Resilient HTTP Client for BD Logistics SDK
 *
 * Standalone HTTP client with circuit breaker and retry patterns.
 * No external dependencies - works in any Node.js environment.
 */

import type {
  HttpClient,
  HttpClientConfig,
  HttpRequestOptions,
  CircuitStatus,
  CircuitState,
} from './types.js';
import { CircuitOpenError, TimeoutError, ProviderAPIError } from './errors.js';

const DEFAULT_CONFIG: Required<HttpClientConfig> = {
  timeout: 15000,
  maxRetries: 3,
  retryDelay: 1000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenMaxRequests: 1,
};

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  private name: string;
  private config: Required<HttpClientConfig>;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenRequests = 0;

  constructor(name: string, config: HttpClientConfig = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canRequest(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      const now = Date.now();
      if (this.lastFailureTime && now - this.lastFailureTime >= this.config.resetTimeout) {
        this.state = 'half-open';
        this.halfOpenRequests = 0;
        return true;
      }
      return false;
    }

    return this.halfOpenRequests < this.config.halfOpenMaxRequests;
  }

  onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenMaxRequests) {
        this.reset();
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenRequests = 0;
  }

  getStatus(): CircuitStatus {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  incrementHalfOpen(): void {
    this.halfOpenRequests++;
  }

  getState(): CircuitState {
    return this.state;
  }
}

// Store circuit breakers per provider
const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(name: string, config: HttpClientConfig = {}): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name, config));
  }
  return circuitBreakers.get(name)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
  providerName: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(providerName, timeout);
    }
    throw error;
  }
}

/**
 * Create HTTP client for a logistics provider
 */
export function createHttpClient(providerName: string, config: HttpClientConfig = {}): HttpClient {
  const clientConfig = { ...DEFAULT_CONFIG, ...config };
  const circuitBreaker = getCircuitBreaker(providerName, {
    failureThreshold: clientConfig.failureThreshold,
    resetTimeout: clientConfig.resetTimeout,
    halfOpenMaxRequests: clientConfig.halfOpenMaxRequests,
  });

  async function request<T = unknown>(
    method: string,
    url: string,
    options: HttpRequestOptions = {}
  ): Promise<T> {
    // Check circuit breaker
    if (!circuitBreaker.canRequest()) {
      throw new CircuitOpenError(providerName, circuitBreaker.getStatus() as unknown as Record<string, unknown>);
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    if (options.body && method !== 'GET') {
      fetchOptions.body = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= clientConfig.maxRetries) {
      try {
        if (circuitBreaker.getState() === 'half-open') {
          circuitBreaker.incrementHalfOpen();
        }

        const response = await fetchWithTimeout(
          url,
          fetchOptions,
          clientConfig.timeout,
          providerName
        );

        if (response.ok) {
          circuitBreaker.onSuccess();
          return response.json() as Promise<T>;
        }

        // Check if status is retryable
        if (clientConfig.retryableStatuses.includes(response.status) && attempt < clientConfig.maxRetries) {
          lastError = new ProviderAPIError(providerName, response.status, response.statusText);
          attempt++;
          await sleep(clientConfig.retryDelay * Math.pow(2, attempt - 1));
          continue;
        }

        // Non-retryable error
        if (response.status >= 500) {
          circuitBreaker.onFailure();
        }

        const errorText = await response.text();
        throw new ProviderAPIError(providerName, response.status, errorText, errorText);

      } catch (error) {
        if (error instanceof ProviderAPIError || error instanceof TimeoutError || error instanceof CircuitOpenError) {
          throw error;
        }

        lastError = error as Error;
        circuitBreaker.onFailure();

        if (attempt < clientConfig.maxRetries) {
          attempt++;
          await sleep(clientConfig.retryDelay * Math.pow(2, attempt - 1));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  return {
    get: <T = unknown>(url: string, options?: HttpRequestOptions) => request<T>('GET', url, options),
    post: <T = unknown>(url: string, options?: HttpRequestOptions) => request<T>('POST', url, options),
    patch: <T = unknown>(url: string, options?: HttpRequestOptions) => request<T>('PATCH', url, options),
    put: <T = unknown>(url: string, options?: HttpRequestOptions) => request<T>('PUT', url, options),
    delete: <T = unknown>(url: string, options?: HttpRequestOptions) => request<T>('DELETE', url, options),
    request,
    getCircuitStatus: () => circuitBreaker.getStatus(),
    resetCircuit: () => circuitBreaker.reset(),
  };
}

/**
 * Get all circuit breaker statuses
 */
export function getAllCircuitStatuses(): Record<string, CircuitStatus> {
  const statuses: Record<string, CircuitStatus> = {};
  for (const [name, breaker] of circuitBreakers) {
    statuses[name] = breaker.getStatus();
  }
  return statuses;
}

/**
 * Reset circuit breaker for a provider
 */
export function resetCircuit(providerName: string): void {
  const breaker = circuitBreakers.get(providerName);
  if (breaker) {
    breaker.reset();
  }
}
