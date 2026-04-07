/**
 * Auth Module Routes
 *
 * Better Auth handles sign-in/up, password reset, sessions at /api/auth/*
 * This module registers:
 * - /users     - CRUD operations (admin) + profile routes (/me)
 * - /members   - Branch member status management
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import userResource from './user.resource.js';
import memberResource from './member.resource.js';

async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const userPlugin = userResource.toPlugin();
  await fastify.register(userPlugin);

  const memberPlugin = memberResource.toPlugin();
  await fastify.register(memberPlugin);
}

export default fp(authRoutes, { name: 'auth-routes' });
