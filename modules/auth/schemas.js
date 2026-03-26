import User from './user.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * User Schemas
 *
 * Auth schemas (login, register, password reset) are handled by Better Auth.
 * This file defines schemas for user CRUD (admin) and profile operations.
 */

/**
 * Update user body — profile fields only
 */
export const updateUserBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
  },
  additionalProperties: false,
};

/**
 * User CRUD Schemas with Field Rules
 */
const {
  createBody,
  updateBody,
  params,
  listQuery,
  crudSchemas,
} = buildCrudSchemasFromModel(User, {
  fieldRules: {
    role: { systemManaged: true },
    isActive: { systemManaged: true },
    lastLoginAt: { systemManaged: true },
  },
  query: {
    filterableFields: {
      name: 'string',
      email: 'string',
      role: 'string',
      isActive: 'boolean',
    },
  },
});

const resolvedCrudSchemas = crudSchemas || {
  create: { body: createBody },
  update: { body: updateBody, params },
  get: { params },
  list: { query: listQuery },
  delete: { params },
};

export const userSchemaOptions = {
  query: {
    allowedPopulate: [],
    filterableFields: {
      name: 'string',
      email: 'string',
      role: 'string',
      isActive: 'boolean',
    },
  },
};

export const userCreateBody = resolvedCrudSchemas.create.body;
export const userUpdateBody = resolvedCrudSchemas.update.body;
export const userGetParams = resolvedCrudSchemas.get.params;
export const userListQuery = resolvedCrudSchemas.list.query;
