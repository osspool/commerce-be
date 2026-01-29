/**
 * Application Entry Point
 * Minimal startup - let Fastify handle the complexity
 */
import './config/env-loader.js';
import closeWithGrace from 'close-with-grace';
import config from './config/index.js';
import logger from '#lib/utils/logger.js';
import { createApplication } from './app.js';

let server;

let _isShuttingDown = false;
async function shutdownAndExit(code, context) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;

  try {
    logger.error(context, 'Fatal process error, attempting graceful shutdown');
  } catch {
    // ignore logger failures
  }

  // Force-exit safeguard (don't hang forever)
  const forceExitTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('Shutdown timeout exceeded, forcing exit');
    process.exit(code);
  }, 10000);
  forceExitTimer.unref();

  try {
    if (server) await server.close();
  } catch (e) {
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
process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  shutdownAndExit(1, { error: error?.message, stack: error?.stack, type: 'uncaughtException' });
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
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
  if (err) server.log.error('Shutdown triggered by error', { error: err.message });
  else server.log.info(`Received ${signal}, shutting down`);
  await server.close();
});

// Start
try {
  const host = process.env.HOST || '0.0.0.0';
  const port = config.app.port || 8040;

  server = await createApplication();
  await server.listen({ port, host });

  server.log.info('Application started', {
    url: `http://${host}:${port}`,
    health: `http://${host}:${port}/health`,
    docs: `http://${host}:${port}/docs`,
    openapi: `http://${host}:${port}/_docs/openapi.json`,
    api: `http://${host}:${port}/api/v1`,
  });
} catch (error) {
  console.error('❌ STARTUP ERROR:', error);
  if (server?.log) {
    server.log.error('Failed to start', { error: error.message, stack: error.stack });
  }
  process.exit(1);
}
