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

export interface WorkerConfigSection {
  worker: {
    mode: string;
    concurrency: number;
    pollIntervalBase: number;
    pollIntervalMax: number;
    healthPort: number;
    healthHost: string;
    shutdownTimeoutMs: number;
    staleJobTimeoutMs: number;
    enableEventHandlers: boolean;
    instanceId: string;
  };
}

const parseBoolean = (val: string | undefined | null, defaultVal: boolean = false): boolean => {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  return val === 'true' || val === '1';
};

const parseIntSafe = (val: string | undefined | null, defaultVal: number): number => {
  const parsed = global.parseInt(val as string, 10);
  return Number.isNaN(parsed) ? defaultVal : parsed;
};

const workerConfig: WorkerConfigSection = {
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

export default workerConfig;
