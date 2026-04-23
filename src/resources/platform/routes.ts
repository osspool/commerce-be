import type { FastifyInstance } from 'fastify';
import featuresResource from './features.resource.js';
import platformResource from './platform.resource.js';

export default async function platformPlugin(fastify: FastifyInstance) {
  await fastify.register(platformResource.toPlugin());
  await fastify.register(featuresResource.toPlugin());
}
