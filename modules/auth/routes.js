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
import { createRoutes } from '#core/factories/createRoutes.js';
import userResource from './user.resource.js';
import userController from './user.controller.js';
import {
  loginBody,
  registerBody,
  refreshBody,
  forgotBody,
  resetBody,
} from './schemas.js';

async function authRoutes(fastify) {
  // ============================================
  // USER RESOURCE (/users)
  // Includes: CRUD + /me profile routes
  // ============================================
  const userPlugin = userResource.toPlugin();
  await fastify.register(userPlugin);

  // ============================================
  // AUTH ROUTES (/auth) - Public
  // ============================================
  await fastify.register(async (instance) => {
    const publicAuthRoutes = [
      {
        method: 'POST',
        url: '/register',
        summary: 'Register new user',
        description: 'Create a new user account',
        schema: { body: registerBody },
        handler: userController.register.bind(userController),
      },
      {
        method: 'POST',
        url: '/login',
        summary: 'User login',
        description: 'Authenticate user and return JWT tokens',
        schema: { body: loginBody },
        handler: userController.login.bind(userController),
      },
      {
        method: 'POST',
        url: '/refresh',
        summary: 'Refresh access token',
        description: 'Get a new access token using refresh token',
        schema: { body: refreshBody },
        handler: userController.refreshToken.bind(userController),
      },
      {
        method: 'POST',
        url: '/forgot-password',
        summary: 'Request password reset',
        description: 'Send password reset email to user',
        schema: { body: forgotBody },
        handler: userController.forgotPassword.bind(userController),
      },
      {
        method: 'POST',
        url: '/reset-password',
        summary: 'Reset password',
        description: 'Reset user password with token from email',
        schema: { body: resetBody },
        handler: userController.resetPassword.bind(userController),
      },
    ];

    createRoutes(instance, publicAuthRoutes, {
      tag: 'Authentication',
      basePath: '/api/v1/auth',
      organizationScoped: false,
    });

    // Organization routes (authenticated)
    const authenticatedAuthRoutes = [
      {
        method: 'GET',
        url: '/organizations',
        summary: 'Get user organizations',
        description: 'Get list of organizations user has access to',
        authRoles: [],
        schema: {},
        handler: userController.getUserOrganizations.bind(userController),
      },
    ];

    createRoutes(instance, authenticatedAuthRoutes, {
      tag: 'Authentication',
      basePath: '/api/v1/auth',
      organizationScoped: false,
      globalMiddlewares: [fastify.authenticate],
    });
  }, { prefix: '/auth' });
}

export default fp(authRoutes, { name: 'auth-routes' });
