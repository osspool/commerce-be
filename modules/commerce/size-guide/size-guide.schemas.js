/**
 * Size Guide JSON Schemas
 *
 * Request validation and response documentation for size guide endpoints.
 */

const sizeSchema = {
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

const sizeGuideEntity = {
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

const createSchema = {
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

const updateSchema = {
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

export default {
    entity: sizeGuideEntity,
    create: createSchema,
    update: updateSchema,
};
