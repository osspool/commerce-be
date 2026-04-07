/**
 * Size Guide JSON Schemas
 *
 * Request validation and response documentation for size guide endpoints.
 */

interface JsonSchemaProperty {
  type: string;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  enum?: string[];
  format?: string;
  pattern?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: JsonSchemaProperty | boolean;
  required?: string[];
  [key: string]: unknown;
}

interface JsonSchemaObject {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

interface RouteSchema {
  body: JsonSchemaObject;
}

interface SizeGuideSchemas {
  entity: JsonSchemaObject;
  create: RouteSchema;
  update: RouteSchema;
}

const sizeSchema: JsonSchemaProperty = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 20 },
    measurements: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['name'],
};

const sizeGuideEntity: JsonSchemaObject = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    measurementUnit: { type: 'string', enum: ['inches', 'cm'] },
    measurementLabels: { type: 'array', items: { type: 'string' } },
    sizes: { type: 'array', items: sizeSchema },
    note: { type: 'string' },
    isActive: { type: 'boolean' },
    displayOrder: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const createSchema: RouteSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
      description: { type: 'string', maxLength: 500 },
      measurementUnit: { type: 'string', enum: ['inches', 'cm'] },
      measurementLabels: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 50 },
        maxItems: 10,
      },
      sizes: { type: 'array', items: sizeSchema },
      note: { type: 'string', maxLength: 1000 },
      isActive: { type: 'boolean' },
      displayOrder: { type: 'number' },
    },
    required: ['name'],
  },
};

const updateSchema: RouteSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      measurementUnit: { type: 'string', enum: ['inches', 'cm'] },
      measurementLabels: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 50 },
        maxItems: 10,
      },
      sizes: { type: 'array', items: sizeSchema },
      note: { type: 'string', maxLength: 1000 },
      isActive: { type: 'boolean' },
      displayOrder: { type: 'number' },
    },
  },
};

const schemas: SizeGuideSchemas = {
  entity: sizeGuideEntity,
  create: createSchema,
  update: updateSchema,
};

export default schemas;
