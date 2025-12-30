/**
 * Worker Process Configuration
 *
 * Supports both in-process (inline) and standalone worker modes.
 *
 * Environment Variables:
 *   WORKER_MODE          - 'inline' (default) or 'standalone'
 *   WORKER_CONCURRENCY   - Number of parallel jobs (default: 1)
 *   WORKER_HEALTH_PORT   - Health server port (default: 8041)
 *   WORKER_HEALTH_HOST   - Health server host (default: 0.0.0.0)
 *   WORKER_SHUTDOWN_TIMEOUT_MS - Graceful shutdown timeout (default: 30000)
 *   WORKER_ENABLE_EVENTS - Enable event handlers (default: true)
 *   WORKER_INSTANCE_ID   - Unique instance identifier
 */

const parseBoolean = (val, defaultVal = false) => {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  return val === 'true' || val === '1';
};

const parseIntSafe = (val, defaultVal) => {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultVal : parsed;
};

export default {
  worker: {
    // Mode: 'inline' = run with API, 'standalone' = separate process
    mode: process.env.WORKER_MODE || 'inline',

    // Concurrency: number of jobs to process in parallel
    concurrency: parseIntSafe(process.env.WORKER_CONCURRENCY, 1),

    // Polling configuration
    pollIntervalBase: parseIntSafe(process.env.WORKER_POLL_INTERVAL_BASE, 1000),
    pollIntervalMax: parseIntSafe(process.env.WORKER_POLL_INTERVAL_MAX, 10000),

    // Health check server (for standalone mode)
    healthPort: parseIntSafe(process.env.WORKER_HEALTH_PORT, 8041),
    healthHost: process.env.WORKER_HEALTH_HOST || '0.0.0.0',

    // Graceful shutdown timeout in ms
    shutdownTimeoutMs: parseIntSafe(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 30000),

    // Stale job recovery timeout (30 minutes)
    staleJobTimeoutMs: parseIntSafe(process.env.WORKER_STALE_JOB_TIMEOUT_MS, 30 * 60 * 1000),

    // Enable/disable event handlers in worker
    enableEventHandlers: parseBoolean(process.env.WORKER_ENABLE_EVENTS, true),

    // Worker instance ID (for distributed logging/tracing)
    instanceId: process.env.WORKER_INSTANCE_ID || `worker-${process.pid}`,
  },
};
