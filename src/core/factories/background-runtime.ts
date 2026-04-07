import config from '#config/index.js';
import logger from '#lib/utils/logger.js';
import cronManager from '../../cron/index.js';
import { eventRegistry as legacyEventRegistry } from '#lib/events/EventRegistry.js';
import { registerInventoryEventHandlers } from '#resources/inventory/inventory.handlers.js';
import { registerPosEventHandlers } from '#resources/sales/pos/pos.events.js';
import { registerAccountingEventHandlers } from '#resources/accounting/accounting.events.js';
import { registerNotificationEventHandlers } from '#resources/notifications/notification.handlers.js';

interface BackgroundRuntimeOptions {
  enableEventHandlers?: boolean;
  enableCronJobs?: boolean;
  mode?: 'inline' | 'standalone';
}

let eventHandlersInitialized = false;
let cronJobsInitialized = false;
let eventHandlersPromise: Promise<void> | null = null;
let cronJobsPromise: Promise<void> | null = null;

async function initializeEventHandlers(): Promise<void> {
  if (eventHandlersInitialized) return;
  if (eventHandlersPromise) return eventHandlersPromise;

  eventHandlersPromise = (async () => {
    try {
      const stats = await legacyEventRegistry.autoDiscoverEvents();
      registerInventoryEventHandlers();
      registerPosEventHandlers();
      registerAccountingEventHandlers();
      registerNotificationEventHandlers();

      logger.info(
        {
          events: stats.eventsRegistered,
          handlers: stats.handlersRegistered,
        },
        'Event handlers registered',
      );
      eventHandlersInitialized = true;
    } catch (error: unknown) {
      logger.warn({ error: (error as Error).message }, 'Event handler registration failed');
    }
  })();

  await eventHandlersPromise;
}

async function initializeCronJobs(): Promise<void> {
  if (cronJobsInitialized) return;
  if (cronJobsPromise) return cronJobsPromise;

  cronJobsPromise = (async () => {
    try {
      await cronManager?.initialize?.();
      logger.info('Cron jobs initialized');
      cronJobsInitialized = true;
    } catch (error: unknown) {
      logger.warn({ error: (error as Error).message }, 'Cron jobs failed to initialize');
    }
  })();

  await cronJobsPromise;
}

export async function initializeBackgroundRuntime(options: BackgroundRuntimeOptions = {}): Promise<void> {
  const {
    enableEventHandlers = true,
    enableCronJobs = config.app.disableCronJobs !== true,
    mode = (config.worker?.mode || 'inline') === 'inline' ? 'inline' : 'standalone',
  } = options;

  if (enableEventHandlers) {
    await initializeEventHandlers();
  } else {
    logger.info({ mode }, 'Event handlers disabled');
  }

  if (enableCronJobs) {
    await initializeCronJobs();
  } else {
    logger.info({ mode }, 'Cron jobs disabled');
  }
}
