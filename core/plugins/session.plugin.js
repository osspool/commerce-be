import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import config from '#config/index.js';
import { getCustomerSession, setCustomerSession, clearCustomerSession } from '#shared/session/session.helpers.js';

/**
 * Session Plugin (Simplified)
 *
 * Just registers @fastify/cookie and decorates request/reply with simple helpers
 * No classes, no managers - just functions (like Next.js)
 *
 * Usage:
 * - request.getCustomerSession() → Get customer from cookie
 * - reply.setCustomerSession(customer) → Store customer in cookie
 * - reply.clearCustomerSession() → Clear cookie
 */
async function sessionPlugin(fastify) {
  // Validate cookie secret
  if (!config.app.cookieSecret) {
    throw new Error('COOKIE_SECRET must be set in environment variables');
  }

  // Register @fastify/cookie
  await fastify.register(cookie, {
    secret: config.app.cookieSecret,
    parseOptions: {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
    }
  });

  // Decorate request with helper (read)
  fastify.decorateRequest('getCustomerSession', function() {
    return getCustomerSession(this);
  });

  // Decorate reply with helpers (write)
  fastify.decorateReply('setCustomerSession', function(customer) {
    return setCustomerSession(this, customer);
  });

  fastify.decorateReply('clearCustomerSession', function() {
    return clearCustomerSession(this);
  });
}

export default fp(sessionPlugin, {
  name: 'session-plugin',
  dependencies: []
});
