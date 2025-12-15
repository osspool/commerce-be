// routes/utils/compose.js (Fastify)
// Minimal helper to compose preHandlers using Fastify decorators
export function withAuth(fastify, roles = []) {
  return roles.length ? [fastify.authenticate, fastify.authorize(...roles)] : [];
}

export function combine(...groups) {
  return groups.flat().filter(Boolean);
}


