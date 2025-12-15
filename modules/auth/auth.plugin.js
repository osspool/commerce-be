import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import { createRoutes } from '#routes/utils/createRoutes.js';
import userController from '#modules/auth/user.controller.js';
import permissions from '#config/permissions.js';
import { userCreateBody, userUpdateBody, userGetParams, userListQuery } from '#modules/auth/schemas.js';
import { getUserByToken, updateUser } from '#modules/auth/userController.js';
import { register, login, refreshToken, forgotPassword, resetPassword, getUserOrganizations } from '#modules/auth/authController.js';
import { loginBody, registerBody, refreshBody, forgotBody, resetBody, updateUserBody } from '#modules/auth/schemas.js';

/**
 * Auth Plugin
 *
 * Manages authentication and user management routes
 * - /auth/* - Public authentication routes (register, login, password reset)
 * - /users/* - Admin user management CRUD
 * - /users/me - Current user profile management
 */
async function authPlugin(fastify, opts) {
  const schemas = {
    list: { query: userListQuery },
    get: { params: userGetParams },
    create: { body: userCreateBody },
    update: { body: userUpdateBody, params: userGetParams },
    remove: { params: userGetParams },
  };

  // CRUD routes for users (admin only)
  await fastify.register(async (instance) => {
    createCrudRouter(instance, userController, {
      tag: 'Users',
      auth: permissions.users,
      schemas,
    });
  }, { prefix: '/users' });

  // Self profile routes (basic user info)
  // /users/me - GET and PATCH endpoints for current user profile
  const userProfileRoutes = [
    {
      method: 'GET',
      url: '/users/me',
      summary: 'Get current user profile',
      description: 'Returns the authenticated user\'s profile information',
      authRoles: [], // Just authenticate, no role check
      schema: {},
      handler: getUserByToken,
    },
    {
      method: 'PATCH',
      url: '/users/me',
      summary: 'Update current user profile',
      description: 'Update the authenticated user\'s profile information',
      authRoles: [], // Just authenticate, no role check
      schema: { body: updateUserBody },
      handler: updateUser,
    },
  ];

  createRoutes(fastify, userProfileRoutes, {
    tag: 'Users',
    basePath: '/api/v1',
    organizationScoped: false, // Profile routes don't need org scoping
    globalMiddlewares: [fastify.authenticate], // Apply auth to all profile routes
  });

  // Authentication routes under /auth
  // Public routes for login, register, password reset
  await fastify.register(async (instance) => {
    const authRoutes = [
      {
        method: 'POST',
        url: '/register',
        summary: 'Register new user',
        description: 'Create a new user account',
        schema: { body: registerBody },
        handler: register,
      },
      {
        method: 'POST',
        url: '/login',
        summary: 'User login',
        description: 'Authenticate user and return JWT tokens',
        schema: { body: loginBody },
        handler: login,
      },
      {
        method: 'POST',
        url: '/refresh',
        summary: 'Refresh access token',
        description: 'Get a new access token using refresh token',
        schema: { body: refreshBody },
        handler: refreshToken,
      },
      {
        method: 'POST',
        url: '/forgot-password',
        summary: 'Request password reset',
        description: 'Send password reset email to user',
        schema: { body: forgotBody },
        handler: forgotPassword,
      },
      {
        method: 'POST',
        url: '/reset-password',
        summary: 'Reset password',
        description: 'Reset user password with token from email',
        schema: { body: resetBody },
        handler: resetPassword,
      },
    ];

    createRoutes(instance, authRoutes, {
      tag: 'Authentication',
      basePath: '/api/v1/auth',
      organizationScoped: false, // Auth routes are public
    });

    // Organization management routes (authenticated)
    const orgManagementRoutes = [
      {
        method: 'GET',
        url: '/organizations',
        summary: 'Get user organizations',
        description: 'Get list of organizations user has access to',
        authRoles: [], // Just authenticate
        schema: {},
        handler: getUserOrganizations,
      },
    ];

    createRoutes(instance, orgManagementRoutes, {
      tag: 'Authentication',
      basePath: '/api/v1/auth',
      organizationScoped: false,
      globalMiddlewares: [fastify.authenticate], // Require auth for these routes
    });
  }, { prefix: '/auth' });
}

export default fp(authPlugin, { name: 'auth-plugin' });


