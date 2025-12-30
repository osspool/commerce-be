/**
 * Worker Process Entry Point
 *
 * Standalone background job processor that runs independently from the API.
 * Designed for production deployment with horizontal scaling.
 *
 * Usage:
 *   node worker.js
 *
 * Environment Variables:
 *   WORKER_MODE=standalone       # Required for standalone mode
 *   WORKER_CONCURRENCY=2         # Number of concurrent jobs
 *   WORKER_HEALTH_PORT=8041      # Health check port
 *   WORKER_ENABLE_EVENTS=true    # Enable event handlers
 *
 * Health Endpoints:
 *   GET /health  - Full health status (for monitoring)
 *   GET /ready   - Readiness probe (for Kubernetes)
 *   GET /live    - Liveness probe (for Kubernetes)
 *
 * Deployment:
 *   # Development
 *   npm run worker:dev
 *
 *   # Production (separate from API)
 *   WORKER_MODE=standalone WORKER_CONCURRENCY=2 node worker.js
 *
 *   # Docker/Kubernetes
 *   command: ["node", "worker.js"]
 *   livenessProbe: { httpGet: { path: /live, port: 8041 } }
 *   readinessProbe: { httpGet: { path: /ready, port: 8041 } }
 */

// Load environment variables FIRST (before any imports that use config)
import './config/env-loader.js';

import { WorkerBootstrap, WorkerHealthServer, setupSignalHandlers } from '#core/worker/index.js';
import config from '#config/index.js';
import logger from '#core/utils/logger.js';

// Validate worker mode
const workerMode = config.worker?.mode || process.env.WORKER_MODE || 'inline';
if (workerMode !== 'standalone') {
  logger.warn({
    workerMode,
    hint: 'Set WORKER_MODE=standalone for production use',
  }, 'Worker started without standalone mode');
}

// Create worker bootstrap instance
const workerBootstrap = new WorkerBootstrap({
  enableJobQueue: true,
  enableEventHandlers: config.worker?.enableEventHandlers !== false,
  enableCronJobs: true, // Cron always runs in worker (per user decision)
  concurrency: config.worker?.concurrency || 1,
});

// Create health server
const healthServer = new WorkerHealthServer({
  port: config.worker?.healthPort || 8041,
  host: config.worker?.healthHost || '0.0.0.0',
});

// Setup graceful shutdown
const shutdown = async () => {
  logger.info('Initiating graceful shutdown...');
  await healthServer.stop();
  await workerBootstrap.shutdown(config.worker?.shutdownTimeoutMs || 30000);
};

setupSignalHandlers(shutdown, {
  timeout: (config.worker?.shutdownTimeoutMs || 30000) + 5000, // Extra buffer for cleanup
  exitOnError: true,
});

// Main entry point
async function main() {
  try {
    const startTime = Date.now();

    logger.info({
      instanceId: config.worker?.instanceId,
      concurrency: config.worker?.concurrency || 1,
      enableEvents: config.worker?.enableEventHandlers !== false,
      enableCron: true,
      healthPort: config.worker?.healthPort || 8041,
      nodeVersion: process.version,
      pid: process.pid,
    }, 'Starting worker process');

    // Initialize worker (DB, job handlers, event handlers, cron)
    await workerBootstrap.initialize();

    // Start health server
    await healthServer.start();

    const duration = Date.now() - startTime;

    logger.info({
      durationMs: duration,
      healthUrl: `http://${config.worker?.healthHost || '0.0.0.0'}:${config.worker?.healthPort || 8041}/health`,
      readyUrl: `http://${config.worker?.healthHost || '0.0.0.0'}:${config.worker?.healthPort || 8041}/ready`,
    }, 'Worker process running');

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
    }, 'Failed to start worker process');
    process.exit(1);
  }
}

// Start the worker
main();
