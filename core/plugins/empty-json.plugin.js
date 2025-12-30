import fp from 'fastify-plugin';

async function emptyJsonPlugin(fastify, opts) {
  // Accept empty JSON bodies (e.g., DELETE with content-type application/json)
  try { if (typeof fastify.removeContentTypeParser === 'function') fastify.removeContentTypeParser('application/json'); } catch {}
  try { if (typeof fastify.removeContentTypeParser === 'function') fastify.removeContentTypeParser('application/*+json'); } catch {}

  const safeJsonParser = (request, body, done) => {
    if (body === '' || body === null || body === undefined) {
      return done(null, {});
    }
    try {
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      done(null, json);
    } catch (err) {
      done(err);
    }
  };

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, safeJsonParser);
  fastify.addContentTypeParser('application/*+json', { parseAs: 'string' }, safeJsonParser);
}

export default fp(emptyJsonPlugin, { name: 'empty-json-plugin' });


