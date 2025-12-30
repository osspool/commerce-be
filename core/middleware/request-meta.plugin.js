import fp from 'fastify-plugin';

async function requestMetaPlugin(fastify, opts) {
  fastify.addHook('onRequest', async (request, reply) => {
    request.context = request.context || {};
  });

  fastify.addHook('preHandler', async (request, reply) => {
    request.validated = {
      body: request.body ? { ...request.body } : undefined,
      query: request.query ? { ...request.query } : undefined,
      params: request.params ? { ...request.params } : undefined,
      headers: request.headers,
    };
  });
}

export default fp(requestMetaPlugin, { name: 'request-meta-plugin' });


