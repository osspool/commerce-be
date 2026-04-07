/**
 * User Resource Definition
 *
 * CRUD operations for user management (admin only)
 * Plus profile operations for authenticated users.
 *
 * Password change is handled by Better Auth at POST /api/auth/change-password.
 */

import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import User from './user.model.js';
import userRepository from './user.repository.js';
import userController from './user.controller.js';
import { userSchemaOptions, updateUserBody } from './schemas.js';
import { events } from './events.js';

const userResource = defineResource({
  name: 'user',
  audit: true,
  displayName: 'Users',
  tag: 'Users',
  prefix: '/users',

  adapter: createAdapter(User, userRepository),
  controller: userController,
  queryParser,

  permissions: getResourcePermissions('user'),
  schemaOptions: userSchemaOptions,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get current user profile',
      description: "Returns the authenticated user's profile information",
      handler: 'getProfile',
      permissions: requireAuth(),
      wrapHandler: false,
      schema: {},
    },
    {
      method: 'PATCH',
      path: '/me',
      summary: 'Update current user profile',
      description: "Update the authenticated user's profile information",
      handler: 'updateProfile',
      permissions: requireAuth(),
      wrapHandler: false,
      schema: { body: updateUserBody },
    },
  ],

  events,
});

export default userResource;
