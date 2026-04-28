/**
 * Application Entry Point
 * Minimal startup - let Fastify handle the complexity
 */
import './config/env-loader.js';
import { createServer } from 'node:net';
import closeWithGrace from 'close-with-grace';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { createApplication } from './app.js';
import config from './config/index.js';

let server: FastifyInstance | undefined;

let _isShuttingDown = false;

async function assertPortAvailable(port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
      .once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${port} is already in use on ${host}. Stop the existing dev server or set PORT to another value.`,
            ),
          );
          return;
        }
        reject(error);
      })
      .once('listening', () => {
        probe.close(() => resolve());
      })
      .listen(port, host);
  });
}

async function shutdownAndExit(code: number, context: Record<string, unknown>): Promise<void> {
  if (_isShuttingDown) return;
  _isShuttingDown = true;

  try {
    logger.error(context, 'Fatal process error, attempting graceful shutdown');
  } catch {
    // ignore logger failures
  }

  // Force-exit safeguard (don't hang forever)
  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown timeout exceeded, forcing exit');
    process.exit(code);
  }, 10000);
  forceExitTimer.unref();

  try {
    if (server) await server.close();
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
      } catch {
        /* already closing */
      }
    }
  } catch (e: unknown) {
    try {
      logger.error({ err: e }, 'Error during shutdown');
    } catch {
      // ignore
    }
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(code);
  }
}

// Global error handlers (fail fast; safe only with a supervisor/restart policy)
process.on('uncaughtException', (error: Error) => {
  console.error(error);
  shutdownAndExit(1, { error: error?.message, stack: error?.stack, type: 'uncaughtException' });
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(reason);
  shutdownAndExit(1, {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    type: 'unhandledRejection',
  });
});

// Graceful shutdown
closeWithGrace({ delay: 10000 }, async ({ signal, err }) => {
  if (err) {
    if (server) server.log.error({ error: err.message }, 'Shutdown triggered by error');
    else logger.error({ error: err.message }, 'Shutdown triggered by error (pre-listen)');
  } else if (server) {
    server.log.info(`Received ${signal}, shutting down`);
  }
  if (server) {
    try {
      await server.close();
    } catch {
      /* server already closing */
    }
  }
  // Explicitly disconnect Mongo so the dying process doesn't keep
  // open sockets alive past the close-grace window. Without this,
  // tsx watch hot-reload races: the old process's still-buffered
  // mongoose ops (especially with the bumped `bufferTimeoutMS` in
  // `db.connect.ts`) keep the event loop alive and the port bound,
  // and the new process gets EADDRINUSE.
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.disconnect();
    } catch {
      /* connection already closing */
    }
  }
});

// Start
try {
  const host: string = process.env.HOST || '0.0.0.0';
  const port: number = config.app.port || 8040;

  await assertPortAvailable(port, host);
  server = await createApplication();
  await server.listen({ port, host });

  server.log.info(
    {
      url: `http://${host}:${port}`,
      health: `http://${host}:${port}/health`,
      docs: `http://${host}:${port}/docs`,
      openapi: `http://${host}:${port}/_docs/openapi.json`,
      api: `http://${host}:${port}/api/v1`,
    },
    'Application started',
  );
} catch (error: unknown) {
  console.error('STARTUP ERROR:', error);
  if (server?.log) {
    server.log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to start');
  }
  process.exit(1);
}
