/**
 * Application Entry Point
 * Minimal startup - let Fastify handle the complexity
 */
import './config/env-loader.js';
import Fastify from 'fastify';
import closeWithGrace from 'close-with-grace';
import config from './config/index.js';
import app from './app.js';
import { createFastifyLogger } from '#common/utils/logger.js';
import logger from '#common/utils/logger.js';

// Global error handlers (before anything else)
process.on('uncaughtException', (error) => {
  console.error(error);
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

// Create server
const server = Fastify({
  ...createFastifyLogger(),
  trustProxy: true,
  ajv: { customOptions: { coerceTypes: true, useDefaults: true, removeAdditional: false } },
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
