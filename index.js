/**
 * Application Entry Point
 * Minimal startup - let Fastify handle the complexity
 */
import './config/env-loader.js';
import Fastify from 'fastify';
import closeWithGrace from 'close-with-grace';
import config from './config/index.js';
import app from './app.js';
import { createFastifyLogger } from '#core/utils/logger.js';
import logger from '#core/utils/logger.js';

// Create server
const server = Fastify({
  ...createFastifyLogger(),
  trustProxy: true,
  ajv: { customOptions: { coerceTypes: true, useDefaults: true, removeAdditional: false } },
});

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
    await server.close();
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
  if (err) server.log.error('Shutdown triggered by error', { error: err.message });
  else server.log.info(`Received ${signal}, shutting down`);
  await server.close();
});

// Start
try {
  await server.register(app);
  
  const host = process.env.HOST || '0.0.0.0';
  const port = config.app.port || 8040;
  
  await server.listen({ port, host });
  
  server.log.info('Application started', {
    url: `http://${host}:${port}`,
    health: `http://${host}:${port}/health`,
    docs: `http://${host}:${port}/api-docs.json`,
    api: `http://${host}:${port}/api/v1`,
  });
} catch (error) {
  console.error('❌ STARTUP ERROR:', error);
  server.log.error('Failed to start', { error: error.message, stack: error.stack });
  process.exit(1);
}
