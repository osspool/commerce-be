import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;

describe('App Boot', () => {
  afterAll(async () => {
    if (app) await app.close();
  });

  it('createApplication() boots without error', async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
    }

    // Seed PlatformConfig (required by loyalty plugin)
    const PlatformConfig = mongoose.models.PlatformConfig;
    if (PlatformConfig) {
      await PlatformConfig.findOneAndUpdate(
        { isSingleton: true },
        { $set: { isSingleton: true, membership: { enabled: false } } },
        { upsert: true },
      );
    }

    const { loadTestResources } = await import('../../support/preload-resources.js');
    const { resources } = await loadTestResources();
    const { createApplication } = await import('../../../src/app.js');
    app = await createApplication({ resources });
    await app.ready();
    expect(app).toBeDefined();
  }, 30_000);

  it('health check returns 200', async () => {
    expect(app).toBeDefined();
    // Arc's healthPlugin auto-registers /_health/live and /_health/ready
    // (no longer the legacy plain /health). Liveness is the lightweight
    // probe — stays 200 even if downstream deps degrade.
    const res = await app!.inject({ method: 'GET', url: '/_health/live' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Arc's healthPlugin returns `{ status: 'ok' }` on /_health/live.
    expect(body.status).toBe('ok');
  });

  it('Arc registry has resources registered', async () => {
    expect(app).toBeDefined();
    const registry = (app as any).arc?.registry;
    expect(registry).toBeDefined();
    const allResources = registry.getAll();
    expect(allResources.length).toBeGreaterThan(10);
  });

  it('OpenAPI spec is available', async () => {
    expect(app).toBeDefined();
    const res = await app!.inject({ method: 'GET', url: '/_docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = JSON.parse(res.body);
    expect(spec.openapi).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it('unknown route returns 404', async () => {
    expect(app).toBeDefined();
    const res = await app!.inject({ method: 'GET', url: '/api/v1/nonexistent-endpoint' });
    expect(res.statusCode).toBe(404);
  });
});
