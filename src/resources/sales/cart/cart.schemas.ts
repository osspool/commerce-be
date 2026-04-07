import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Cart from './cart.model.js';

export const cartSchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {},
  query: {
    allowedPopulate: ['items.product'],
  },
};

export const addItemSchema = {
  body: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      variantSku: { type: 'string', nullable: true },
      quantity: { type: 'number', minimum: 1 },
    },
    required: ['productId', 'quantity'],
  },
} as const;

export const updateItemSchema = {
  params: {
    type: 'object',
    properties: {
      itemId: { type: 'string' },
    },
    required: ['itemId'],
  },
  body: {
    type: 'object',
    properties: {
      quantity: { type: 'number', minimum: 1 },
    },
    required: ['quantity'],
  },
} as const;

export const removeItemSchema = {
  params: {
    type: 'object',
    properties: {
      itemId: { type: 'string' },
    },
    required: ['itemId'],
  },
} as const;

const crudSchemas = buildCrudSchemasFromModel(
  Cart,
  cartSchemaOptions as Parameters<typeof buildCrudSchemasFromModel>[1],
);

export default crudSchemas;
