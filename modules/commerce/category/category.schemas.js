/**
 * Category Schemas
 */
const categorySchemas = {
    body: {
        type: 'object',
        properties: {
            name: { type: 'string', minLength: 1 },
            parent: { type: 'string', description: 'Parent category slug' },
            description: { type: 'string' },
            image: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    alt: { type: 'string' },
                },
            },
            displayOrder: { type: 'number' },
            vatRate: { type: 'number', minimum: 0, maximum: 100, nullable: true },
            isActive: { type: 'boolean' },
            seo: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
    createBody: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1 },
            parent: { type: 'string' },
            description: { type: 'string' },
            image: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    alt: { type: 'string' },
                },
            },
            displayOrder: { type: 'number' },
            vatRate: { type: 'number', minimum: 0, maximum: 100 },
            isActive: { type: 'boolean' },
        },
    },
    response: {
        type: 'object',
        properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            parent: { type: 'string', nullable: true },
            description: { type: 'string' },
            image: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    alt: { type: 'string' },
                },
            },
            displayOrder: { type: 'number' },
            vatRate: { type: 'number', nullable: true },
            isActive: { type: 'boolean' },
            productCount: { type: 'number' },
        },
    },
};

export default categorySchemas;
