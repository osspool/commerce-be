/**
 * Worker Health Server
 *
 * Minimal HTTP server for health checks in standalone worker mode.
 * Designed for Kubernetes liveness/readiness probes.
 *
 * Endpoints:
 *   GET /health  - Full health status with DB state, memory
 *   GET /ready   - Readiness probe (is worker ready?)
 *   GET /live    - Liveness probe (is process alive?)
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import mongoose from 'mongoose';
import logger from '#core/utils/logger.js';

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  pid: number;
  database: {
    connected: boolean;
    name: string | null;
    host: string | null;
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    externalMB: number;
  };
}

interface ReadinessStatus {
  ready: boolean;
  database: boolean;
}

interface WorkerHealthServerOptions {
  port?: number;
  host?: string;
}

export class WorkerHealthServer {
  port: number;
  host: string;
  server: http.Server | null;

  constructor(options: WorkerHealthServerOptions = {}) {
    this.port = options.port || 8041;
    this.host = options.host || '0.0.0.0';
    this.server = null;
  }

  /**
   * Get comprehensive health status
   */
  async getHealth(): Promise<HealthStatus> {
    const dbConnected = mongoose.connection.readyState === 1;

    const memUsage = process.memoryUsage();

    return {
      status: dbConnected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
      database: {
        connected: dbConnected,
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
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
   * Check if worker is ready
   */
  async isReady(): Promise<ReadinessStatus> {
    const dbReady = mongoose.connection.readyState === 1;

    return {
      ready: dbReady,
      database: dbReady,
    };
  }

  /**
   * Handle incoming HTTP requests
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          res.end(
            JSON.stringify({
              error: 'Not Found',
              endpoints: ['/health', '/ready', '/live'],
            }),
          );
      }
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Health check error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
  }

  /**
   * Start the health server
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error: Error) => {
        logger.error({ error: error.message }, 'Health server error');
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        logger.info(
          {
            port: this.port,
            host: this.host,
            endpoints: {
              health: `http://${this.host}:${this.port}/health`,
              ready: `http://${this.host}:${this.port}/ready`,
              live: `http://${this.host}:${this.port}/live`,
            },
          },
          'Worker health server started',
        );
        resolve();
      });
    });
  }

  /**
   * Stop the health server
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
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
