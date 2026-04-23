import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';

export type MongoStatus = 'connected' | 'disconnected';

export interface ReadinessResult {
  ready: boolean;
  checks: {
    mongo: MongoStatus;
  };
}

export function checkReadiness(conn: { readyState: number } = mongoose.connection): ReadinessResult {
  const mongo: MongoStatus = conn.readyState === 1 ? 'connected' : 'disconnected';
  return {
    ready: mongo === 'connected',
    checks: { mongo },
  };
}

export function registerHealthRoutes(fastify: FastifyInstance): void {
  fastify.get('/health', async () => ({ success: true, message: 'OK' }));

  fastify.get('/health/ready', async (_req, reply) => {
    const result = checkReadiness();
    reply.code(result.ready ? 200 : 503);
    return result;
  });
}
