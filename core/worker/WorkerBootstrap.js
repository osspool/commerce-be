/**
 * Worker Bootstrap
 *
 * Shared initialization logic for worker processes.
 * Can be used standalone or integrated into the API process.
 *
 * Responsibilities:
 * - Database connection (without Fastify)
 * - Job handler registration
 * - Event handler registration
 * - Cron job initialization
 * - Graceful shutdown coordination
 */

import mongoose from 'mongoose';
import { jobQueue } from '#modules/job/JobQueue.js';
import { registerAllJobHandlers } from '#modules/job/job.registry.js';
import { eventRegistry } from '#core/events/EventRegistry.js';
import { registerInventoryEventHandlers } from '#modules/inventory/inventory.handlers.js';
import logger from '#core/utils/logger.js';
import config from '#config/index.js';

export class WorkerBootstrap {
  constructor(options = {}) {
    this.options = {
      enableJobQueue: true,
      enableEventHandlers: true,
      enableCronJobs: true,
      concurrency: config.worker?.concurrency || 1,
      ...options,
    };

    this.isInitialized = false;
    this.isShuttingDown = false;
  }

  /**
   * Connect to database (standalone, without Fastify)
   */
  async connectDatabase() {
    // Check if already connected (reuse for tests or multi-init)
    if (mongoose.connection.readyState === 1) {
      logger.info({ database: mongoose.connection.name }, 'Database already connected');
      return;
    }

    // Check for test environment override
    const uri = globalThis.__MONGO_URI__ || process.env.MONGO_URI || config.db?.uri;

    if (!uri) {
      throw new Error('MONGO_URI is not defined');
    }

    const maxRetries = parseInt(process.env.DB_CONNECT_MAX_RETRIES, 10) || 5;
    const baseDelayMs = parseInt(process.env.DB_CONNECT_RETRY_MS, 10) || 2000;
    const backoffMultiplier = parseFloat(process.env.DB_CONNECT_BACKOFF) || 1.5;

    let attempt = 0;
    let delayMs = baseDelayMs;

    mongoose.set('strictQuery', true);

    while (attempt < maxRetries) {
      attempt++;
      try {
        logger.info({ attempt, maxRetries }, 'Connecting to database');

        await mongoose.connect(uri, {
          serverSelectionTimeoutMS: 10000,
          socketTimeoutMS: 45000,
          maxPoolSize: 10, // Lower pool size for worker
        });

        logger.info({
          database: mongoose.connection.name,
          host: mongoose.connection.host,
        }, 'Database connected');

        // Set up connection event handlers
        mongoose.connection.on('error', (error) => {
          logger.error({ error: error.message }, 'MongoDB connection error');
        });

        mongoose.connection.on('disconnected', () => {
          if (!this.isShuttingDown) {
            logger.warn('MongoDB disconnected unexpectedly');
          }
        });

        mongoose.connection.on('reconnected', () => {
          logger.info('MongoDB reconnected');
        });

        return;
      } catch (error) {
        logger.error({ attempt, error: error.message }, 'Database connection failed');

        if (attempt >= maxRetries) {
          throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffMultiplier, 60000);
      }
    }
  }

  /**
   * Initialize job queue and handlers
   */
  async initializeJobQueue() {
    if (!this.options.enableJobQueue) {
      logger.info('Job queue disabled by configuration');
      return;
    }

    // Register all module job handlers
    await registerAllJobHandlers();

    // Configure concurrency
    if (this.options.concurrency > 1 && jobQueue.config) {
      jobQueue.config.concurrency = this.options.concurrency;
      logger.info({ concurrency: this.options.concurrency }, 'Job queue concurrency configured');
    }

    // Start polling for jobs
    jobQueue.startPolling();
    logger.info({ concurrency: this.options.concurrency }, 'Job queue started');
  }

  /**
   * Initialize event handlers
   */
  async initializeEventHandlers() {
    if (!this.options.enableEventHandlers) {
      logger.info('Event handlers disabled by configuration');
      return;
    }

    // Auto-discover events from modules
    try {
      const stats = await eventRegistry.autoDiscoverEvents();
      logger.info({
        events: stats.eventsRegistered,
        handlers: stats.handlersRegistered,
        files: stats.filesScanned,
      }, 'Domain events auto-discovered');

      if (stats.errors.length > 0) {
        logger.warn({ errorCount: stats.errors.length }, 'Event discovery had errors');
        stats.errors.forEach(err => {
          logger.debug({ file: err.file, error: err.error }, 'Event discovery error');
        });
      }
    } catch (error) {
      logger.warn({ error: error.message }, 'Event auto-discovery failed');
    }

    // Register legacy inventory handlers
    try {
      registerInventoryEventHandlers();
      logger.info('Legacy inventory event handlers registered');
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to register inventory handlers');
    }
  }

  /**
   * Initialize cron jobs
   */
  async initializeCronJobs() {
    if (!this.options.enableCronJobs) {
      logger.info('Cron jobs disabled by configuration');
      return;
    }

    try {
      const cronManager = (await import('../../cron/index.js')).default;
      if (cronManager?.initialize) {
        await cronManager.initialize();
        logger.info('Cron jobs initialized');
      }
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to initialize cron jobs');
    }
  }

  /**
   * Full initialization sequence
   */
  async initialize() {
    if (this.isInitialized) {
      logger.warn('Worker already initialized');
      return;
    }

    const startTime = Date.now();
    logger.info({
      enableJobQueue: this.options.enableJobQueue,
      enableEventHandlers: this.options.enableEventHandlers,
      enableCronJobs: this.options.enableCronJobs,
      concurrency: this.options.concurrency,
    }, 'Worker bootstrap starting');

    // 1. Database connection (required)
    await this.connectDatabase();

    // 2. Job queue (with handlers)
    await this.initializeJobQueue();

    // 3. Event handlers
    await this.initializeEventHandlers();

    // 4. Cron jobs
    await this.initializeCronJobs();

    this.isInitialized = true;
    const duration = Date.now() - startTime;
    logger.info({ durationMs: duration }, 'Worker bootstrap complete');
  }

  /**
   * Graceful shutdown
   */
  async shutdown(timeout = 30000) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    const startTime = Date.now();
    logger.info({ timeout }, 'Worker shutdown starting');

    try {
      // 1. Shutdown job queue first (waits for active jobs)
      if (this.options.enableJobQueue && jobQueue) {
        try {
          await jobQueue.shutdown(timeout);
          logger.info('Job queue shutdown complete');
        } catch (error) {
          logger.error({ error: error.message }, 'Error shutting down job queue');
        }
      }

      // 2. Close database connection
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info('Database connection closed');
      }

      const duration = Date.now() - startTime;
      logger.info({ durationMs: duration }, 'Worker shutdown complete');
    } catch (error) {
      logger.error({ error: error.message }, 'Error during worker shutdown');
      throw error;
    }
  }
}

export default WorkerBootstrap;
