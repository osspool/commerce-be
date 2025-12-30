/**
 * Core Plugin Registry
 * Single-tenant e-commerce - keep it simple!
 *
 * Plugin Categories:
 * 1. Security & Infrastructure (helmet, cors, rate limiting)
 * 2. Parsing & Validation (JWT, JSON)
 * 3. Database (Mongoose)
 * 4. Authentication
 * 5. Utilities (cache, request-meta, response)
 */

import fp from 'fastify-plugin';

// Security & Infrastructure
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import rateLimit from '@fastify/rate-limit';

// Parsing & Validation
import rawBody from 'fastify-raw-body';
import fastifyJwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import emptyJsonPlugin from '#core/plugins/empty-json.plugin.js';
import schemaGeneratorPlugin from '#core/plugins/schema-generator.plugin.js';

// Database
import mongoosePlugin from '#config/db.plugin.js';

// Authentication
import authPlugin from '#core/plugins/auth.plugin.js';

// Utilities
import sessionPlugin from '#core/plugins/session.plugin.js';
import requestMetaPlugin from '#core/middleware/request-meta.plugin.js';
import cachePlugin from '#core/plugins/cache.plugin.js';
import responsePlugin from '#core/middleware/response.plugin.js';

// Config
import config from '#config/index.js';

async function registerCorePlugins(fastify) {
  // ============================================
  // 1. Security & Infrastructure
  // ============================================
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      }
    }
  });

  await fastify.register(cors, {
    origin: config.isDevelopment
      ? (origin, cb) => {
          // In development, allow all origins
          cb(null, true);
        }
      : (origin, cb) => {
          // In production, check against allowed origins
          if (!origin) return cb(null, true);
          if (Array.isArray(config.cors.origin) && config.cors.origin.includes(origin)) {
            return cb(null, true);
          }
          cb(new Error('Not allowed by CORS'), false);
        },
    credentials: config.cors.credentials,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });

  await fastify.register(sensible);
  await fastify.register(underPressure, { exposeStatusRoute: true });
  await fastify.register(rateLimit, { max: 200, timeWindow: '1 minute' });

  // ============================================
  // 2. Parsing & Validation
  // ============================================
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max file size
      files: 10, // Max 10 files per request
    },
  });

  await fastify.register(fastifyJwt, { secret: config.app.jwtSecret });
  await fastify.register(emptyJsonPlugin);
  await fastify.register(schemaGeneratorPlugin);

  // ============================================
  // 3. Database
  // ============================================
  await fastify.register(mongoosePlugin);

  // ============================================
  // 4. Authentication
  // ============================================
  await fastify.register(authPlugin);

  // ============================================
  // 5. Utilities
  // ============================================
  await fastify.register(sessionPlugin);
  await fastify.register(requestMetaPlugin);
  await fastify.register(cachePlugin);
  await fastify.register(responsePlugin);
}

export default fp(registerCorePlugins, { name: 'register-core-plugins' });
