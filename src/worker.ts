import './config/env-loader.js';
import config from './config/index.js';
import logger from '#lib/utils/logger.js';
import { WorkerBootstrap, WorkerHealthServer, setupSignalHandlers } from '#lib/worker/index.js';

let healthServer: WorkerHealthServer | null = null;
const worker = new WorkerBootstrap({
  enableEventHandlers: config.worker.enableEventHandlers,
  enableCronJobs: config.app.disableCronJobs !== true,
});

async function startWorker(): Promise<void> {
  await worker.initialize();

  healthServer = new WorkerHealthServer({
    port: config.worker.healthPort,
    host: config.worker.healthHost,
  });
  await healthServer.start();

  logger.info(
    {
      instanceId: config.worker.instanceId,
      healthPort: config.worker.healthPort,
      healthHost: config.worker.healthHost,
    },
    'Worker started',
  );
}

async function shutdownWorker(): Promise<void> {
  if (healthServer) {
    await healthServer.stop();
    healthServer = null;
  }

  await worker.shutdown(config.worker.shutdownTimeoutMs);
}

setupSignalHandlers(shutdownWorker, {
  timeout: config.worker.shutdownTimeoutMs,
});

try {
  await startWorker();
} catch (error: unknown) {
  const err = error as Error;
  logger.error({ error: err.message, stack: err.stack }, 'Worker failed to start');
  process.exit(1);
}
