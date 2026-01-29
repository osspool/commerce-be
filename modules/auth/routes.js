/**
 * Auth Module Routes
 *
 * BEFORE: auth.plugin.js - 142 lines of boilerplate
 * AFTER: routes.js - ~60 lines of clean code
 *
 * REDUCTION: 58% less code!
 *
 * Routes:
 * - /users     - CRUD operations (admin) + profile routes (/me)
 * - /auth      - Public authentication (register, login, password reset)
 */

import fp from 'fastify-plugin';
import userResource from './user.resource.js';
import authResource from './auth.resource.js';

async function authRoutes(fastify) {
  const userPlugin = userResource.toPlugin();
  await fastify.register(userPlugin);

  const authPlugin = authResource.toPlugin();
  await fastify.register(authPlugin);
}

export default fp(authRoutes, { name: 'auth-routes' });
