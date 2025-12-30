/**
 * Worker Health Server
 *
 * Minimal HTTP server for health checks in standalone worker mode.
 * Designed for Kubernetes liveness/readiness probes.
 *
 * Endpoints:
 *   GET /health  - Full health status with queue stats, DB state, memory
 *   GET /ready   - Readiness probe (is worker ready to process jobs?)
 *   GET /live    - Liveness probe (is process alive?)
 */

import http from 'http';
import mongoose from 'mongoose';
import { jobQueue } from '#modules/job/JobQueue.js';
import logger from '#core/utils/logger.js';

export class WorkerHealthServer {
  constructor(options = {}) {
    this.port = options.port || 8041;
    this.host = options.host || '0.0.0.0';
    this.server = null;
  }

  /**
   * Get comprehensive health status
   */
  async getHealth() {
    const dbConnected = mongoose.connection.readyState === 1;

    let queueStats = {
      isPolling: false,
      isShuttingDown: false,
      activeWorkers: 0,
      pending: 0,
      processing: 0,
      failed: 0,
    };

    try {
      queueStats = await jobQueue.getStats();
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to get queue stats');
    }

    const memUsage = process.memoryUsage();

    return {
      status: dbConnected && !jobQueue.isShuttingDown ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
      database: {
        connected: dbConnected,
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
      },
      queue: {
        isPolling: queueStats.isPolling,
        isShuttingDown: queueStats.isShuttingDown,
        activeWorkers: queueStats.activeWorkers,
        pending: queueStats.pending,
        processing: queueStats.processing,
        failed: queueStats.failed,
      },
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        externalMB: Math.round(memUsage.external / 1024 / 1024),
      },
    };
  }

  /**
   * Check if worker is ready to process jobs
   */
  async isReady() {
    const dbReady = mongoose.connection.readyState === 1;
    const queueReady = jobQueue.isPolling && !jobQueue.isShuttingDown;

    return {
      ready: dbReady && queueReady,
      database: dbReady,
      queue: queueReady,
    };
  }

  /**
   * Handle incoming HTTP requests
   */
  async handleRequest(req, res) {
    const url = req.url?.split('?')[0]; // Remove query string

    try {
      switch (url) {
        case '/health':
        case '/healthz': {
          const health = await this.getHealth();
          const statusCode = health.status === 'healthy' ? 200 : 503;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health, null, 2));
          break;
        }

        case '/ready':
        case '/readyz': {
          const readiness = await this.isReady();
          const statusCode = readiness.ready ? 200 : 503;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(readiness));
          break;
        }

        case '/live':
        case '/livez': {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ alive: true, pid: process.pid }));
          break;
        }

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Not Found',
            endpoints: ['/health', '/ready', '/live'],
          }));
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Health check error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: error.message }));
    }
  }

  /**
   * Start the health server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        logger.error({ error: error.message }, 'Health server error');
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        logger.info({
          port: this.port,
          host: this.host,
          endpoints: {
            health: `http://${this.host}:${this.port}/health`,
            ready: `http://${this.host}:${this.port}/ready`,
            live: `http://${this.host}:${this.port}/live`,
          },
        }, 'Worker health server started');
        resolve();
      });
    });
  }

  /**
   * Stop the health server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Worker health server stopped');
          this.server = null;
          resolve();
        });

        // Force close after 5 seconds
        setTimeout(() => {
          if (this.server) {
            this.server = null;
            resolve();
          }
        }, 5000);
      } else {
        resolve();
      }
    });
  }
}

export default WorkerHealthServer;
