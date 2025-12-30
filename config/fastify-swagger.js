import { getApiSpec } from '#core/docs/apiDocs.js';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

const version = '1.0.0';

const swaggerBase = {
  openapi: '3.0.0',
  info: {
    title: 'API Documentation',
    version,
    description: 'Documentation for the API',
  },
  servers: [ { url: '/', description: 'API Server' } ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [ { bearerAuth: [] } ],
};

export default async function setupFastifySwagger(fastify) {
  // Register OpenAPI spec source
  await fastify.register(swagger, {
    openapi: {
      ...swaggerBase,
      // dynamically resolve paths/components on request via transform
    },
    transformStaticCSP: true,
    refResolver: {
      buildLocalReference(json, baseUri, fragment, i) {
        return `def-${i}`;
      },
    },
  });

  // Serve UI
  await fastify.register(swaggerUI, {
    routePrefix: '/api-docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
    transformSpecification: (swaggerObject, request, reply) => {
      const dynamicSpec = getApiSpec();
      return {
        ...swaggerObject,
        ...dynamicSpec,
        components: { ...swaggerObject.components, ...(dynamicSpec.components || {}) },
      };
    },
    transformSpecificationClone: true,
  });

  // Also expose JSON for programmatic access
  fastify.get('/api-docs.json', async (request, reply) => {
    const dynamicSpec = getApiSpec();
    const swaggerDefinition = {
      ...swaggerBase,
      ...dynamicSpec,
      components: { ...swaggerBase.components, ...(dynamicSpec.components || {}) },
    };
    reply.header('Content-Type', 'application/json').send(swaggerDefinition);
  });
}


