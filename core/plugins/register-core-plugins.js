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
  // ============================================
  // ALLOW EMPTY JSON BODIES
  // ============================================
  // Many frontend libraries (axios, fetch) send Content-Type: application/json
  // even for DELETE/GET requests without body. Fastify rejects empty bodies by default.
  // This parser gracefully handles empty bodies as empty objects.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        // Handle empty body (common for DELETE requests with Content-Type header)
        if (!body || body === '') {
          done(null, {});
          return;
        }
        // Parse non-empty JSON
        done(null, JSON.parse(body));
      } catch (err) {
        done(err, undefined);
      }
    }
  );

  await fastify.register(errorHandlerPlugin);
}

export default fp(registerCorePlugins, { name: 'register-core-plugins' });
