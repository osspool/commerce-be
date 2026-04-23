/**
 * Worker Bootstrap
 *
 * Shared initialization logic for worker processes.
 * Can be used standalone or integrated into the API process.
 *
 * Responsibilities:
 * - Database connection (without Fastify)
 * - Event handler registration
 * - Cron job initialization
 * - Graceful shutdown coordination
 */

import mongoose from 'mongoose';
import config from '#config/index.js';
import { initializeBackgroundRuntime } from '#core/factories/background-runtime.js';
import logger from '#lib/utils/logger.js';

interface WorkerOptions {
  enableEventHandlers?: boolean;
  enableCronJobs?: boolean;
}

interface ResolvedWorkerOptions {
  enableEventHandlers: boolean;
  enableCronJobs: boolean;
}

export class WorkerBootstrap {
  options: ResolvedWorkerOptions;
  isInitialized: boolean;
  isShuttingDown: boolean;

  constructor(options: WorkerOptions = {}) {
    this.options = {
      enableEventHandlers: true,
      enableCronJobs: true,
      ...options,
    };

    this.isInitialized = false;
    this.isShuttingDown = false;
  }

  /**
   * Connect to database (standalone, without Fastify)
   */
  async connectDatabase(): Promise<void> {
    // Check if already connected (reuse for tests or multi-init)
    if (mongoose.connection.readyState === 1) {
      logger.info({ database: mongoose.connection.name }, 'Database already connected');
      return;
    }

    // Check for test environment override
    const uri: string | undefined =
      (globalThis as Record<string, any>).__MONGO_URI__ ||
      process.env.MONGO_URI ||
      (config as Record<string, any>).db?.uri;

    if (!uri) {
      throw new Error('MONGO_URI is not defined');
    }

    const maxRetries = parseInt(process.env.DB_CONNECT_MAX_RETRIES as string, 10) || 5;
    const baseDelayMs = parseInt(process.env.DB_CONNECT_RETRY_MS as string, 10) || 2000;
    const backoffMultiplier = parseFloat(process.env.DB_CONNECT_BACKOFF as string) || 1.5;

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

        logger.info(
          {
            database: mongoose.connection.name,
            host: mongoose.connection.host,
          },
          'Database connected',
        );

        // Set up connection event handlers
        mongoose.connection.on('error', (error: Error) => {
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
        const err = error as Error;
        logger.error({ attempt, error: err.message }, 'Database connection failed');

        if (attempt >= maxRetries) {
          throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${err.message}`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffMultiplier, 60000);
      }
    }
  }

  /**
   * Initialize event handlers
   */
  async initializeEventHandlers(): Promise<void> {
    if (!this.options.enableEventHandlers) {
      logger.info('Event handlers disabled by configuration');
      return;
    }
    await initializeBackgroundRuntime({
      mode: 'standalone',
      enableEventHandlers: true,
      enableCronJobs: false,
    });
  }

  /**
   * Initialize cron jobs
   */
  async initializeCronJobs(): Promise<void> {
    if (!this.options.enableCronJobs) {
      logger.info('Cron jobs disabled by configuration');
      return;
    }
    await initializeBackgroundRuntime({
      mode: 'standalone',
      enableEventHandlers: false,
      enableCronJobs: true,
    });
  }

  /**
   * Full initialization sequence
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Worker already initialized');
      return;
    }

    const startTime = Date.now();
    logger.info(
      {
        enableEventHandlers: this.options.enableEventHandlers,
        enableCronJobs: this.options.enableCronJobs,
      },
      'Worker bootstrap starting',
    );

    // 1. Database connection (required)
    await this.connectDatabase();

    // 2. Event handlers
    await this.initializeEventHandlers();

    // 3. Cron jobs
    await this.initializeCronJobs();

    this.isInitialized = true;
    const duration = Date.now() - startTime;
    logger.info({ durationMs: duration }, 'Worker bootstrap complete');
  }

  /**
   * Graceful shutdown
   */
  async shutdown(timeout: number = 30000): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    const startTime = Date.now();
    logger.info({ timeout }, 'Worker shutdown starting');

    try {
      // 1. Close database connection
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info('Database connection closed');
      }

      const duration = Date.now() - startTime;
      logger.info({ durationMs: duration }, 'Worker shutdown complete');
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Error during worker shutdown');
      throw error;
    }
  }
}

export default WorkerBootstrap;
