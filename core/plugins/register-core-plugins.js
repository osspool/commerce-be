/**
 * Core Plugin Registry
 * Single-tenant e-commerce - keep it simple!
 *
 * Plugin Categories:
 * 1. Security & Infrastructure (helmet, cors, rate limiting)
 * 2. Parsing & Validation (JWT, JSON)
 * 3. Database (Mongoose)
 * 4. Authentication
 * 5. Utilities (cache, request-meta, response)
 * 6. Response Filtering (cost price filter)
 */

import fp from 'fastify-plugin';
import errorHandlerPlugin from '#core/plugins/error-handler.plugin.js';

async function registerCorePlugins(fastify) {
  await fastify.register(errorHandlerPlugin);
}

export default fp(registerCorePlugins, { name: 'register-core-plugins' });
