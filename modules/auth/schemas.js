import User from './user.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Auth Schemas
 * 
 * User model is auth-only (email, password, roles).
 * Profile data (addresses, phone) lives in Customer model.
 */

export const loginBody = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
  },
  required: ['email', 'password'],
  additionalProperties: false,
};

export const registerBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
    phone: { type: 'string' },
  },
  required: ['name', 'email', 'password'],
  additionalProperties: false,
};

export const refreshBody = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1 },
  },
  required: ['token'],
  additionalProperties: false,
};

export const forgotBody = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
  additionalProperties: false,
};

export const resetBody = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1 },
    newPassword: { type: 'string', minLength: 6 },
  },
  required: ['token', 'newPassword'],
  additionalProperties: false,
};

export const changePasswordBody = {
  type: 'object',
  properties: {
    currentPassword: { type: 'string', minLength: 1 },
    newPassword: { type: 'string', minLength: 6 },
  },
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
};

export const getProfileBody = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
  additionalProperties: false,
};

/**
 * Update user body - auth fields only
 * Name and email only. Addresses/phone managed via Customer.
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
    password: { systemManaged: true },
    roles: { systemManaged: true },
    resetPasswordToken: { systemManaged: true },
    resetPasswordExpires: { systemManaged: true },
    isActive: { systemManaged: true },
    lastLoginAt: { systemManaged: true },
  },
  query: {
    filterableFields: {
      name: 'string',
      email: 'string',
      roles: 'string',
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

// Export schema options for controller
export const userSchemaOptions = {
  query: {
    allowedPopulate: [],
    filterableFields: {
      name: 'string',
      email: 'string',
      roles: 'string',
      isActive: 'boolean',
    },
  },
};

// Re-export shapes expected by auth routes
export const userCreateBody = resolvedCrudSchemas.create.body;
export const userUpdateBody = resolvedCrudSchemas.update.body;
export const userGetParams = resolvedCrudSchemas.get.params;
export const userListQuery = resolvedCrudSchemas.list.query;
