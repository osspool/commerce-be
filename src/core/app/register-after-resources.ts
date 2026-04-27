import type { FastifyInstance } from 'fastify';
import { isFeatureEnabled } from '#config/features.js';
import config from '#config/index.js';
import { initializeBackgroundRuntime } from '#core/factories/background-runtime.js';
import { registerResourceHooks } from '#shared/hooks.js';

export async function registerAfterResources(fastify: FastifyInstance): Promise<void> {
  const isInlineWorkerMode = (config.worker?.mode || 'inline') === 'inline';

  registerResourceHooks(fastify);

  fastify.addHook('onClose', async () => {
    const { shutdown: shutdownCron } = await import('../../cron/index.js');
    shutdownCron();
  });

  // Legacy onRequest day-close hook deleted — POS posting is now driven
  // by `@classytic/pos`'s shift-close LedgerBridge. Stale shifts are
  // recovered by the orphan-shift cron, not by per-request side effects.

  if (isInlineWorkerMode) {
    await initializeBackgroundRuntime({
      mode: 'inline',
      enableEventHandlers: true,
      enableCronJobs: config.app.disableCronJobs !== true,
    });
  }
}
