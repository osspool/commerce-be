/**
 * User Resource Definition
 *
 * CRUD operations for user management (admin only)
 * Plus profile operations for authenticated users
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import User from './user.model.js';
import userRepository from './user.repository.js';
import userController from './user.controller.js';
import permissions from '#config/permissions.js';
import { userSchemaOptions, updateUserBody, changePasswordBody } from './schemas.js';
import { events } from './events.js';

const userResource = defineResource({
  name: 'user',
  displayName: 'Users',
  tag: 'Users',
  prefix: '/users',

  model: User,
  repository: userRepository,
  controller: userController,

  permissions: permissions.users,
  schemaOptions: userSchemaOptions,

  additionalRoutes: [
    // Profile routes (authenticated users, no role required)
    {
      method: 'GET',
      path: '/me',
      summary: 'Get current user profile',
      description: 'Returns the authenticated user\'s profile information',
      handler: 'getProfile',
      authRoles: [], // Just authenticate, no role check
      schemas: {},
    },
    {
      method: 'PATCH',
      path: '/me',
      summary: 'Update current user profile',
      description: 'Update the authenticated user\'s profile information',
      handler: 'updateProfile',
      authRoles: [], // Just authenticate, no role check
      schemas: {
        body: updateUserBody,
      },
    },
    {
      method: 'POST',
      path: '/me/change-password',
      summary: 'Change password',
      description: 'Change current user password (requires current password)',
      handler: 'changePassword',
      authRoles: [], // Just authenticate, no role check
      schemas: {
        body: changePasswordBody,
      },
    },
  ],

  events: events,
});

export default userResource;
