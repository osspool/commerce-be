/**
 * Smart Persistent Job Queue
 *
 * Production-grade background job processing with:
 * - Retry with exponential backoff
 * - Graceful shutdown
 * - Dead letter queue
 * - Job priority
 * - Atomic locking
 * - Crash recovery
 *
 * Inspired by Sidekiq, Bull, and Netflix's resilience patterns.
 */

import EventEmitter from 'events';
import Job from './job.model.js';
import logger from '#core/utils/logger.js';
import { JOB_TYPES } from '#shared/constants/enums.js';

// Default configuration
const DEFAULT_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,
  maxRetryDelayMs: 30000,
  pollIntervalBase: 1000,
  pollIntervalMax: 10000,
  staleJobTimeoutMs: 30 * 60 * 1000, // 30 minutes
  gracefulShutdownTimeoutMs: 30000,
  concurrency: 1, // Jobs processed at a time
};

/**
 * Persistent Job Queue with Retry Logic
 */
class PersistentJobQueue extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.running = false;
    this.isPolling = false;
    this.isShuttingDown = false;
    this._pollTimer = null;
    this._activeJobs = new Set();
    this.jobHandlers = new Map();

    // Smart polling state
    this.currentPollInterval = this.config.pollIntervalBase;
    this.lastRecoveryCheck = 0;

    // Bind methods
    this.processNext = this.processNext.bind(this);
    this.on('process', this.processNext);
  }

  /**
   * Register a job handler
   *
   * @param {string} jobType - Job type identifier
   * @param {Function} handler - Async handler function
   * @param {Object} [options] - Handler options
   * @param {number} [options.maxRetries] - Override default max retries
   * @param {number} [options.timeout] - Job timeout in ms
   */
  registerHandler(jobType, handler, options = {}) {
    this.jobHandlers.set(jobType, { handler, options });
    logger.info({ jobType }, 'Job handler registered');
  }

  /**
   * Add a job to the queue
   *
   * @param {Object} data - Job data
   * @param {string} data.type - Job type
   * @param {Object} [data.data] - Job payload
   * @param {number} [data.priority=0] - Higher = processed first
   * @param {number} [data.delay=0] - Delay in ms before processing
   * @returns {Promise<Object>} Created job
   */
  async add(data) {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down, cannot add new jobs');
    }

    try {
      const scheduledFor = data.delay
        ? new Date(Date.now() + data.delay)
        : new Date();

      const job = await Job.create({
        type: data.type,
        data: data.data || {},
        priority: data.priority || 0,
        status: 'pending',
        attempts: 0,
        maxRetries: data.maxRetries ?? this.config.maxRetries,
        scheduledFor,
      });

      logger.info({ jobId: job._id, type: job.type }, 'Job added to queue');

      // Reset backoff and trigger processing
      this.currentPollInterval = this.config.pollIntervalBase;
      this.emit('process');

      return job;
    } catch (error) {
      logger.error({ err: error, type: data.type }, 'Failed to add job to queue');
      throw error;
    }
  }

  /**
   * Add multiple jobs at once
   *
   * @param {Array} jobs - Array of job data
   * @returns {Promise<Array>} Created jobs
   */
  async addBulk(jobs) {
    const createdJobs = await Promise.all(
      jobs.map(job => this.add(job))
    );
    return createdJobs;
  }

  /**
   * Start the polling loop
   */
  startPolling() {
    if (this.isPolling || this.isShuttingDown) return;
    this.isPolling = true;

    logger.info('Job queue polling started');

    const poll = async () => {
      if (this.isShuttingDown) return;

      if (!this.running) {
        this.emit('process');
      }

      this._pollTimer = setTimeout(poll, this.currentPollInterval);
    };

    poll();
  }

  /**
   * Stop polling
   */
  stopPolling() {
    this.isPolling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Graceful shutdown
   *
   * @param {number} [timeout] - Shutdown timeout in ms
   * @returns {Promise<void>}
   */
  async shutdown(timeout = this.config.gracefulShutdownTimeoutMs) {
    if (this.isShuttingDown) return;

    logger.info('Job queue shutting down...');
    this.isShuttingDown = true;
    this.stopPolling();

    // Wait for active jobs to complete
    const startTime = Date.now();

    while (this._activeJobs.size > 0) {
      if (Date.now() - startTime > timeout) {
        logger.warn(
          { activeJobs: this._activeJobs.size },
          'Shutdown timeout reached, forcing shutdown'
        );
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Mark any still-processing jobs as interrupted for recovery
    if (this._activeJobs.size > 0) {
      await Job.updateMany(
        { _id: { $in: Array.from(this._activeJobs) } },
        {
          $set: { status: 'pending', error: 'Interrupted by shutdown' },
        }
      );
    }

    logger.info('Job queue shutdown complete');
  }

  /**
   * Recover stale jobs (stuck in processing)
   */
  async recoverStaleJobs() {
    const now = Date.now();

    // Run recovery check at most once per minute
    if (now - this.lastRecoveryCheck < 60000) return;
    this.lastRecoveryCheck = now;

    const cutoffDate = new Date(now - this.config.staleJobTimeoutMs);

    try {
      const result = await Job.updateMany(
        {
          status: 'processing',
          startedAt: { $lt: cutoffDate },
        },
        {
          $set: { status: 'pending', error: 'Recovered from stale state' },
          $inc: { attempts: 1 },
        }
      );

      if (result.modifiedCount > 0) {
        logger.warn({ count: result.modifiedCount }, 'Recovered stale jobs');
        this.currentPollInterval = this.config.pollIntervalBase;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to recover stale jobs');
    }
  }

  /**
   * Process the next available job
   */
  async processNext() {
    if (this.running || this.isShuttingDown) return;
    this.running = true;

    let currentJobId = null;

    try {
      // Periodic maintenance
      await this.recoverStaleJobs();

      // Find and lock the next job atomically
      const job = await Job.findOneAndUpdate(
        {
          status: 'pending',
          scheduledFor: { $lte: new Date() },
        },
        {
          $set: { status: 'processing', startedAt: new Date() },
          $inc: { attempts: 1 },
        },
        {
          sort: { priority: -1, createdAt: 1 }, // Higher priority first, then FIFO
          new: true,
        }
      );

      if (!job) {
        this.running = false;
        // Exponential backoff when queue is empty
        this.currentPollInterval = Math.min(
          this.currentPollInterval * 1.5,
          this.config.pollIntervalMax
        );
        return;
      }

      // Reset backoff - found work
      this.currentPollInterval = this.config.pollIntervalBase;
      currentJobId = job._id;
      this._activeJobs.add(job._id.toString());

      // Get handler
      const handlerConfig = this.jobHandlers.get(job.type);
      if (!handlerConfig) {
        await Job.findByIdAndUpdate(job._id, {
          status: 'failed',
          completedAt: new Date(),
          error: `No handler registered for job type: ${job.type}`,
          lastError: `No handler registered for job type: ${job.type}`,
          lastErrorAt: new Date(),
        });
        logger.error({ jobId: job._id, type: job.type }, 'Job failed: missing handler');
        this.emit('failed', { job, error: new Error(`No handler registered for job type: ${job.type}`) });
        return;
      }

      const { handler, options: handlerOptions } = handlerConfig;
      const maxRetries = job.maxRetries ?? handlerOptions.maxRetries ?? this.config.maxRetries;

      // Execute with optional timeout
      const jobData = {
        jobId: job._id,
        type: job.type,
        data: job.data || {},
        attempts: job.attempts,
        maxRetries,
      };

      if (handlerOptions.timeout) {
        await this._executeWithTimeout(handler, jobData, handlerOptions.timeout);
      } else {
        await handler(jobData);
      }

      // Mark complete
      await Job.findByIdAndUpdate(job._id, {
        status: 'completed',
        completedAt: new Date(),
        error: null,
      });

      logger.info({ jobId: job._id, type: job.type, attempts: job.attempts }, 'Job completed');
      this.emit('completed', job);

    } catch (error) {
      logger.error({ err: error, jobId: currentJobId }, 'Job processing failed');

      if (currentJobId) {
        await this._handleJobFailure(currentJobId, error);
      }
    } finally {
      if (currentJobId) {
        this._activeJobs.delete(currentJobId.toString());
      }
      this.running = false;

      // Check for more jobs immediately if we processed one
      if (currentJobId && !this.isShuttingDown) {
        setImmediate(() => this.emit('process'));
      }
    }
  }

  /**
   * Handle job failure with retry logic
   */
  async _handleJobFailure(jobId, error) {
    const job = await Job.findById(jobId);
    if (!job) return;

    const handlerConfig = this.jobHandlers.get(job.type) || {};
    const maxRetries = job.maxRetries ?? handlerConfig.options?.maxRetries ?? this.config.maxRetries;

    if (job.attempts < maxRetries) {
      // Calculate retry delay with exponential backoff
      const delay = Math.min(
        this.config.retryDelayMs * Math.pow(this.config.retryBackoffMultiplier, job.attempts - 1),
        this.config.maxRetryDelayMs
      );

      const scheduledFor = new Date(Date.now() + delay);

      await Job.findByIdAndUpdate(jobId, {
        status: 'pending',
        scheduledFor,
        error: error.message,
        lastError: error.message,
        lastErrorAt: new Date(),
      });

      logger.info(
        { jobId, type: job.type, attempt: job.attempts, maxRetries, retryIn: delay },
        'Job scheduled for retry'
      );

      this.emit('retry', { job, error, attempt: job.attempts, nextRetryIn: delay });
    } else {
      // Max retries exceeded - move to dead letter
      await Job.findByIdAndUpdate(jobId, {
        status: 'failed',
        completedAt: new Date(),
        error: error.message,
        lastError: error.message,
        lastErrorAt: new Date(),
      });

      logger.error(
        { jobId, type: job.type, attempts: job.attempts },
        'Job moved to dead letter queue (max retries exceeded)'
      );

      this.emit('failed', { job, error });
    }
  }

  /**
   * Execute handler with timeout
   */
  async _executeWithTimeout(handler, jobData, timeout) {
    return Promise.race([
      handler(jobData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Job timeout after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  /**
   * Retry a failed job manually
   *
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Updated job
   */
  async retryJob(jobId) {
    const job = await Job.findByIdAndUpdate(
      { _id: jobId, status: 'failed' },
      {
        status: 'pending',
        scheduledFor: new Date(),
        error: null,
      },
      { new: true }
    );

    if (job) {
      logger.info({ jobId }, 'Job manually retried');
      this.emit('process');
    }

    return job;
  }

  /**
   * Get queue statistics
   *
   * @returns {Promise<Object>} Queue stats
   */
  async getStats() {
    const [pending, processing, completed, failed] = await Promise.all([
      Job.countDocuments({ status: 'pending' }),
      Job.countDocuments({ status: 'processing' }),
      Job.countDocuments({ status: 'completed' }),
      Job.countDocuments({ status: 'failed' }),
    ]);

    return {
      pending,
      processing,
      completed,
      failed,
      total: pending + processing + completed + failed,
      activeWorkers: this._activeJobs.size,
      isPolling: this.isPolling,
      isShuttingDown: this.isShuttingDown,
    };
  }

  /**
   * Get failed jobs (dead letter queue)
   *
   * @param {Object} [options] - Query options
   * @param {number} [options.limit=50] - Max jobs to return
   * @param {string} [options.type] - Filter by job type
   * @returns {Promise<Array>} Failed jobs
   */
  async getFailedJobs(options = {}) {
    const { limit = 50, type } = options;

    const query = { status: 'failed' };
    if (type) query.type = type;

    return Job.find(query)
      .sort({ completedAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Clear completed jobs older than specified age
   *
   * @param {number} [maxAgeMs=7*24*60*60*1000] - Max age in ms (default 7 days)
   * @returns {Promise<number>} Number of jobs deleted
   */
  async clearOldJobs(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs);

    const result = await Job.deleteMany({
      status: { $in: ['completed', 'failed'] },
      completedAt: { $lt: cutoff },
    });

    if (result.deletedCount > 0) {
      logger.info({ count: result.deletedCount }, 'Cleared old jobs');
    }

    return result.deletedCount;
  }
}

// Create singleton instance
export const jobQueue = new PersistentJobQueue();


export default jobQueue;
