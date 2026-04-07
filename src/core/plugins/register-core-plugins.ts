/**
 * Core Plugin Registry
 *
 * Kept as a named plugin so that downstream plugins can declare
 * `dependencies: ['register-core-plugins']` for ordering.
 * All actual work (error handling, security, parsing) is handled by Arc's createApp.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

async function registerCorePlugins(_fastify: FastifyInstance): Promise<void> {
  // Arc handles: error handler, helmet, cors, rate-limit, JSON parsing, auth
}

export default fp(registerCorePlugins, { name: 'register-core-plugins' });
