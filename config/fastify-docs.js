import { openApiPlugin, scalarPlugin } from '@classytic/arc/docs';

const version = '1.0.0';

export default async function setupFastifyDocs(fastify) {
  // Schemas are auto-generated at resource definition time (no schemaProvider needed)
  await fastify.register(openApiPlugin, {
    title: 'API Documentation',
    version,
    description: 'OpenAPI spec generated from Arc resources',
    serverUrl: '/',
    apiPrefix: '/api/v1',
  });

  await fastify.register(scalarPlugin, {
    routePrefix: '/docs',
    specUrl: '/_docs/openapi.json',
    title: 'API Documentation',
    theme: 'kepler',
  });
}
