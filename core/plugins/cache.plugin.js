import fp from 'fastify-plugin';
import LRUCache from '#utils/LRUCache.js';

function now() { return Date.now(); }

function buildCache({ maxSize = 200, ttlMs = 30000, varyByUser = false } = {}) {
  const store = new LRUCache(maxSize);
  function makeKey(request) {
    const userKey = varyByUser ? (request.user?._id || request.user?.id || '') : '';
    const url = request.raw?.url || request.url;
    return `${userKey}:${url}`;
  }
  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expireAt && entry.expireAt < now()) return null;
    return entry;
  }
  const middleware = async function cachePreHandler(request, reply) {
    if (request.method !== 'GET') return;
    const key = makeKey(request);
    const hit = get(key);
    if (hit) {
      reply.header('X-Cache', 'HIT');
      return reply.code(200).send(hit.payload);
    }
    reply.header('X-Cache', 'MISS');
    const originalSend = reply.send.bind(reply);
    reply.send = (payload) => {
      try { store.set(key, { payload, expireAt: now() + ttlMs }); } catch (_) {}
      return originalSend(payload);
    };
  };
  return { middleware };
}

async function cachePlugin(fastify, opts) {
  fastify.decorate('buildResponseCache', buildCache);
}

export default fp(cachePlugin, { name: 'cache-plugin' });
export { buildCache as createResponseCache };



