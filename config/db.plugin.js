/**
 * MongoDB Connection Plugin
 * Connects to database and decorates Fastify with mongoose
 */
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import config from './index.js';

async function mongooseConnector(fastify) {
  const uri = config.db.uri;
  
  if (!uri) {
    throw new Error('MONGO_URI is not defined in configuration');
  }

  // Connection settings
  const maxRetries = process.env.DB_CONNECT_MAX_RETRIES ? Number(process.env.DB_CONNECT_MAX_RETRIES) : 5;
  const baseDelayMs = process.env.DB_CONNECT_RETRY_MS ? Number(process.env.DB_CONNECT_RETRY_MS) : 2000;
  const backoff = process.env.DB_CONNECT_BACKOFF ? Number(process.env.DB_CONNECT_BACKOFF) : 1.5;

  mongoose.set('strictQuery', true);

  let attempt = 0;
  let delayMs = baseDelayMs;

  // Retry connection with exponential backoff
  while (attempt < maxRetries) {
    attempt++;
    try {
      fastify.log.info('Connecting to database', { attempt });
      
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 20,
      });

      fastify.log.info('Database connected', { database: mongoose.connection.name });
      break;
      
    } catch (error) {
      fastify.log.error('Database connection failed', { attempt, error: error.message });

      if (attempt >= maxRetries) {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * backoff, 60000);
    }
  }

  // Connection event handlers
  mongoose.connection.on('error', (error) => {
    fastify.log.error('MongoDB connection error', { error: error.message });
  });

  mongoose.connection.on('disconnected', () => {
    fastify.log.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    fastify.log.info('MongoDB reconnected');
  });

  // Decorate fastify with mongoose
  fastify.decorate('mongoose', mongoose);

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    try {
      await mongoose.disconnect();
      fastify.log.info('Database connection closed');
    } catch (error) {
      fastify.log.error('Error closing database', { error: error.message });
    }
  });
}

export default fp(mongooseConnector, { name: 'mongoose-connector' });
