import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { JsonSchema } from '@classytic/repo-core/schema';
import User from './user.model.js';

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
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, minLength: 1 },
    email: { type: 'string' as const, format: 'email' },
  },
  additionalProperties: false,
} as const;

/**
 * User CRUD Schemas with Field Rules
 */
const crudSchemas = buildCrudSchemasFromModel(User, {
  fieldRules: {
    role: { systemManaged: true },
    isActive: { systemManaged: true },
    lastLoginAt: { systemManaged: true },
  },
});

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

export const userCreateBody: JsonSchema = crudSchemas.createBody;
export const userUpdateBody: JsonSchema = crudSchemas.updateBody;
export const userGetParams: JsonSchema = crudSchemas.params;
export const userListQuery: JsonSchema = crudSchemas.listQuery;
