import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { allowPublic, requireAuth } from '@classytic/arc/permissions';
import userController from './user.controller.js';
import userRepository from './user.repository.js';
import User from './user.model.js';
import {
  loginBody,
  registerBody,
  refreshBody,
  forgotBody,
  resetBody,
} from './schemas.js';

const authResource = defineResource({
  name: 'auth',
  displayName: 'Authentication',
  tag: 'Authentication',
  prefix: '/auth',

  adapter: createMongooseAdapter({
    model: User,
    repository: userRepository,
  }),

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/register',
      summary: 'Register new user',
      description: 'Create a new user account',
      permissions: allowPublic(),
      wrapHandler: false,
      handler: userController.register.bind(userController),
      schema: { body: registerBody },
    },
    {
      method: 'POST',
      path: '/login',
      summary: 'User login',
      description: 'Authenticate user and return JWT tokens',
      permissions: allowPublic(),
      wrapHandler: false,
      handler: userController.login.bind(userController),
      schema: { body: loginBody },
    },
    {
      method: 'POST',
      path: '/refresh',
      summary: 'Refresh access token',
      description: 'Get a new access token using refresh token',
      permissions: allowPublic(),
      wrapHandler: false,
      handler: userController.refreshToken.bind(userController),
      schema: { body: refreshBody },
    },
    {
      method: 'POST',
      path: '/forgot-password',
      summary: 'Request password reset',
      description: 'Send password reset email to user',
      permissions: allowPublic(),
      wrapHandler: false,
      handler: userController.forgotPassword.bind(userController),
      schema: { body: forgotBody },
    },
    {
      method: 'POST',
      path: '/reset-password',
      summary: 'Reset password',
      description: 'Reset user password with token from email',
      permissions: allowPublic(),
      wrapHandler: false,
      handler: userController.resetPassword.bind(userController),
      schema: { body: resetBody },
    },
    {
      method: 'GET',
      path: '/organizations',
      summary: 'Get user organizations',
      description: 'Get list of organizations user has access to',
      permissions: requireAuth(),
      wrapHandler: false,
      handler: userController.getUserOrganizations.bind(userController),
    },
  ],
});

export default authResource;
