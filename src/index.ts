/**
 * Application Entry Point
 * Minimal startup - let Fastify handle the complexity
 */
import './config/env-loader.js';
import closeWithGrace from 'close-with-grace';
import type { FastifyInstance } from 'fastify';
import logger from '#lib/utils/logger.js';
import { createApplication } from './app.js';
import config from './config/index.js';

let server: FastifyInstance | undefined;

let _isShuttingDown = false;
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
  if (!server) return;
  if (err) server.log.error({ error: err.message }, 'Shutdown triggered by error');
  else server.log.info(`Received ${signal}, shutting down`);
  await server.close();
});

// Start
try {
  const host: string = process.env.HOST || '0.0.0.0';
  const port: number = config.app.port || 8040;

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
