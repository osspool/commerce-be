import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { checkReadiness, registerHealthRoutes } from '../../src/core/health.js';

describe('checkReadiness', () => {
  it('reports ready only when mongo readyState === 1', () => {
    expect(checkReadiness({ readyState: 1 }).ready).toBe(true);
    expect(checkReadiness({ readyState: 0 }).ready).toBe(false);
    expect(checkReadiness({ readyState: 2 }).ready).toBe(false);
    expect(checkReadiness({ readyState: 3 }).ready).toBe(false);
  });

  it('labels mongo=connected vs mongo=disconnected', () => {
    expect(checkReadiness({ readyState: 1 }).checks.mongo).toBe('connected');
    expect(checkReadiness({ readyState: 0 }).checks.mongo).toBe('disconnected');
    expect(checkReadiness({ readyState: 2 }).checks.mongo).toBe('disconnected');
  });
});

describe('registerHealthRoutes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerHealthRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health is liveness — always 200 with success:true', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ success: true, message: 'OK' });
  });

  it('GET /health/ready returns 503 when mongo is not connected', async () => {
    // Default mongoose.connection.readyState is 0 (disconnected) in this bare
    // Fastify instance — no mongoose.connect() call has been made.
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.ready).toBe(false);
    expect(body.checks.mongo).toBe('disconnected');
  });
});
