/**
 * User Resource Definition
 *
 * CRUD operations for user management (admin only)
 * Plus profile operations for authenticated users.
 *
 * Password change is handled by Better Auth at POST /api/auth/change-password.
 */

import { defineResource, fields } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireAuth } from '@classytic/arc/permissions';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { events } from './events.js';
import { updateUserBody } from './schemas.js';
import userController from './user.controller.js';
import User from './user.model.js';
import userRepository from './user.repository.js';

const userResource = defineResource({
  name: 'user',
  audit: true,
  displayName: 'Users',
  tag: 'Users',
  prefix: '/users',

  // Users are platform-wide — BA links them to orgs via the `member` collection,
  // not via a per-doc tenant column. Forwarded to UserController's super() call;
  // arc 2.13 silently drops resource-level options when a custom controller is
  // supplied, so the controller is the canonical source of truth.

  adapter: createMongooseAdapter(User, userRepository),
  controller: userController,
  queryParser,

  permissions: getResourcePermissions('user'),

  // BA stores `password` (hash) in the same collection via strict:false overlay.
  // Hide it at the arc-pipeline level so it never enters response serialization,
  // OpenAPI/MCP schemas, or write payloads. user.model.ts also strips it via
  // toJSON/toObject as defense-in-depth for direct mongoose serialization paths.
  fields: {
    password: fields.hidden(),
  },

  routes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get current user profile',
      description: "Returns the authenticated user's profile information",
      handler: 'getProfile',
      permissions: requireAuth(),
      schema: {},
    },
    {
      method: 'PATCH',
      path: '/me',
      summary: 'Update current user profile',
      description: "Update the authenticated user's profile information",
      handler: 'updateProfile',
      permissions: requireAuth(),
      schema: { body: updateUserBody },
    },
  ],

  events,
});

export default userResource;
