/**
 * Resilient HTTP Client
 *
 * Provides circuit breaker and retry patterns for external API calls.
 * Used primarily for logistics providers (RedX, Pathao, etc.)
 *
 * Features:
 * - Circuit breaker: Fails fast when provider is down
 * - Exponential backoff retry: Handles transient failures
 * - Timeout handling: Prevents hanging requests
 * - Request tracking: For debugging and metrics
 */

const DEFAULT_CONFIG = {
  // Retry settings
  maxRetries: 3,
  retryDelay: 1000, // Base delay in ms (doubles each retry)
  retryableStatuses: [408, 429, 500, 502, 503, 504],

  // Circuit breaker settings
  failureThreshold: 5,      // Failures before circuit opens
  resetTimeout: 30000,      // Time in ms before trying again (30s)
  halfOpenMaxRequests: 1,   // Requests allowed in half-open state

  // Request settings
  timeout: 10000, // 10s default timeout
};

/**
 * Circuit Breaker States
 */
const CIRCUIT_STATE = {
  CLOSED: 'closed',         // Normal operation
  OPEN: 'open',             // Failing fast
  HALF_OPEN: 'half-open',   // Testing recovery
};

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  constructor(name, config = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenRequests = 0;
  }

  /**
   * Check if request can proceed
   */
  canRequest() {
    if (this.state === CIRCUIT_STATE.CLOSED) {
      return true;
    }

    if (this.state === CIRCUIT_STATE.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.config.resetTimeout) {
        this.state = CIRCUIT_STATE.HALF_OPEN;
        this.halfOpenRequests = 0;
        return true;
      }
      return false;
    }

    // Half-open: allow limited requests
    return this.halfOpenRequests < this.config.halfOpenMaxRequests;
  }

  /**
   * Record successful request
   */
  onSuccess() {
    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenMaxRequests) {
        this.reset();
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  /**
   * Record failed request
   */
  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.state = CIRCUIT_STATE.OPEN;
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = CIRCUIT_STATE.OPEN;
    }
  }

  /**
   * Reset circuit to closed state
   */
  reset() {
    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenRequests = 0;
  }

  /**
   * Get circuit status for monitoring
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// Store circuit breakers per service
const circuitBreakers = new Map();

/**
 * Get or create circuit breaker for a service
 */
function getCircuitBreaker(serviceName, config = {}) {
  if (!circuitBreakers.has(serviceName)) {
    circuitBreakers.set(serviceName, new CircuitBreaker(serviceName, config));
  }
  return circuitBreakers.get(serviceName);
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url, options, timeout) {
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
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Resilient fetch with circuit breaker and retry
 *
 * @param {string} url - Request URL
 * @param {Object} options - Fetch options
 * @param {Object} config - Resilience config
 * @param {string} config.serviceName - Service identifier for circuit breaker
 * @param {number} config.timeout - Request timeout in ms
 * @param {number} config.maxRetries - Max retry attempts
 * @param {number} config.retryDelay - Base retry delay in ms
 * @param {Array} config.retryableStatuses - HTTP statuses to retry
 * @param {Object} config.circuitBreaker - Circuit breaker config overrides
 */
export async function resilientFetch(url, options = {}, config = {}) {
  const {
    serviceName = 'default',
    timeout = DEFAULT_CONFIG.timeout,
    maxRetries = DEFAULT_CONFIG.maxRetries,
    retryDelay = DEFAULT_CONFIG.retryDelay,
    retryableStatuses = DEFAULT_CONFIG.retryableStatuses,
    circuitBreakerConfig = {},
  } = config;

  const circuitBreaker = getCircuitBreaker(serviceName, circuitBreakerConfig);

  // Check circuit breaker
  if (!circuitBreaker.canRequest()) {
    const status = circuitBreaker.getStatus();
    throw Object.assign(
      new Error(`Circuit breaker OPEN for ${serviceName}. Service is temporarily unavailable.`),
      { code: 'CIRCUIT_OPEN', status }
    );
  }

  let lastError = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      if (circuitBreaker.state === CIRCUIT_STATE.HALF_OPEN) {
        circuitBreaker.halfOpenRequests++;
      }

      const response = await fetchWithTimeout(url, options, timeout);

      // Check if response is successful
      if (response.ok) {
        circuitBreaker.onSuccess();
        return response;
      }

      // Check if status is retryable
      if (retryableStatuses.includes(response.status) && attempt < maxRetries) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        lastError.status = response.status;
        attempt++;
        await sleep(retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
        continue;
      }

      // Non-retryable error - still need to handle as failure if 5xx
      if (response.status >= 500) {
        circuitBreaker.onFailure();
      }

      return response;
    } catch (error) {
      lastError = error;
      circuitBreaker.onFailure();

      // Network errors are retryable
      if (attempt < maxRetries && !error.code?.includes('CIRCUIT')) {
        attempt++;
        await sleep(retryDelay * Math.pow(2, attempt - 1));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Request failed after retries');
}

/**
 * Create a resilient HTTP client for a specific service
 *
 * @param {string} serviceName - Service identifier
 * @param {Object} defaultConfig - Default config for all requests
 * @returns {Object} HTTP client with get, post, patch, delete methods
 */
export function createResilientClient(serviceName, defaultConfig = {}) {
  const clientConfig = { serviceName, ...defaultConfig };

  async function request(method, url, options = {}) {
    const fetchOptions = {
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

    const response = await resilientFetch(url, fetchOptions, {
      ...clientConfig,
      ...options.resilience,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw Object.assign(
        new Error(`${serviceName} API error: ${response.status} - ${errorText}`),
        { status: response.status, body: errorText }
      );
    }

    return response.json();
  }

  return {
    get: (url, options = {}) => request('GET', url, options),
    post: (url, options = {}) => request('POST', url, options),
    patch: (url, options = {}) => request('PATCH', url, options),
    put: (url, options = {}) => request('PUT', url, options),
    delete: (url, options = {}) => request('DELETE', url, options),
    request,
    getCircuitStatus: () => getCircuitBreaker(serviceName).getStatus(),
    resetCircuit: () => getCircuitBreaker(serviceName).reset(),
  };
}

/**
 * Get all circuit breaker statuses (for monitoring)
 */
export function getAllCircuitStatuses() {
  const statuses = {};
  for (const [name, breaker] of circuitBreakers) {
    statuses[name] = breaker.getStatus();
  }
  return statuses;
}

/**
 * Reset specific circuit breaker
 */
export function resetCircuit(serviceName) {
  const breaker = circuitBreakers.get(serviceName);
  if (breaker) {
    breaker.reset();
  }
}

export default {
  resilientFetch,
  createResilientClient,
  getAllCircuitStatuses,
  resetCircuit,
};
