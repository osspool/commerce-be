/**
 * MongoDB Connection Plugin
 *
 * Thin wrapper around `connectDatabase()` that decorates Fastify with mongoose
 * and registers cleanup hooks. The actual connection logic lives in db.connect.ts
 * so it can also be called from app.ts BEFORE Arc resource discovery runs
 * (engines need a connected mongoose to create their owned models).
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { connectDatabase } from './db.connect.js';

declare module 'fastify' {
  interface FastifyInstance {
    mongoose: typeof mongoose;
  }
}

async function mongooseConnector(fastify: FastifyInstance): Promise<void> {
  // Connect (idempotent — returns immediately if already connected)
  await connectDatabase({ log: (msg) => fastify.log.info(msg) });

  // Connection event handlers
  mongoose.connection.on('error', () => fastify.log.error('MongoDB connection error'));
  mongoose.connection.on('disconnected', () => fastify.log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => fastify.log.info('MongoDB reconnected'));

  // Decorate fastify with mongoose
  fastify.decorate('mongoose', mongoose);

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    try {
      await mongoose.disconnect();
      fastify.log.info('Database connection closed');
    } catch {
      fastify.log.error('Error closing database');
    }
  });
}

export default fp(mongooseConnector, { name: 'mongoose-connector' });
