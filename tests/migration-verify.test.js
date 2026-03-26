/**
 * Migration Verification Tests
 *
 * Uses Arc 2.3.0 built-in test harness:
 *   - createHttpTestHarness: Auto-generated CRUD + permission tests per resource
 *   - createJwtAuthProvider: JWT auth token generation
 *   - createTestApp: Standalone Arc app for unit tests
 *   - request/createTestAuth/waitFor: HTTP + auth + async helpers
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  createTestApp,
  request,
  createTestAuth,
  createJwtAuthProvider,
  createHttpTestHarness,
  waitFor,
} from '@classytic/arc/testing';

// ─── Shared test state ─────────────────────────────────────────────────────────

let server;
let auth;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  if (globalThis.__MONGO_URI__) {
    process.env.MONGO_URI = globalThis.__MONGO_URI__;
  }

  const { createApplication } = await import('../app.js');
  server = await createApplication();
  await server.ready();

  auth = createJwtAuthProvider({
    app: server,
    users: {
      admin: { payload: { id: 'test-admin', name: 'Admin', role: ['admin'], isAdmin: true } },
      user: { payload: { id: 'test-user', name: 'User', role: ['user'] } },
      storeStaff: { payload: { id: 'test-staff', name: 'Staff', role: ['store-staff'] } },
    },
    adminRole: 'admin',
  });
}, 60000);

afterAll(async () => {
  if (server) await server.close();
});

// ─── 1. App Bootstrap ───────────────────────────────────────────────────────────

describe('App bootstrap', () => {
  it('should boot successfully', () => {
    expect(server).toBeDefined();
  });

  it('should serve health', async () => {
    const res = await request(server).get('/health').send();
    expect(res.statusCode).toBe(200);
  });
});

// ─── 2. Arc Event System ────────────────────────────────────────────────────────

describe('Arc events', () => {
  it('should have fastify.events decorated', () => {
    expect(server.events).toBeDefined();
    expect(typeof server.events.publish).toBe('function');
    expect(typeof server.events.subscribe).toBe('function');
  });

  it('should publish and subscribe', async () => {
    const received = [];
    const unsub = await server.events.subscribe('test.harness', (e) => received.push(e));
    await server.events.publish('test.harness', { ok: true });
    await waitFor(() => received.length > 0, { timeout: 2000 });
    expect(received[0].payload).toEqual({ ok: true });
    if (typeof unsub === 'function') unsub();
  });

  it('should work through arcEvents.js wrapper', async () => {
    const { publish, subscribe } = await import('../lib/events/arcEvents.js');
    const received = [];
    const unsub = await subscribe('test.wrapper', (e) => received.push(e));
    await publish('test.wrapper', { wrapped: true });
    await waitFor(() => received.length > 0, { timeout: 2000 });
    expect(received[0].payload).toEqual({ wrapped: true });
    if (typeof unsub === 'function') unsub();
  });
});

// ─── 3. JWT Auth ────────────────────────────────────────────────────────────────

describe('JWT auth', () => {
  it('should sign and verify via createTestAuth', () => {
    const testAuth = createTestAuth(server);
    const token = testAuth.generateToken({ id: '1', roles: ['admin'] });
    const decoded = testAuth.decodeToken(token);
    expect(decoded.id).toBe('1');
  });

  it('should reject unauthenticated requests', async () => {
    const res = await request(server).get('/api/v1/auth/organizations').send();
    expect(res.statusCode).toBe(401);
  });

  it('should accept authenticated requests', async () => {
    const res = await request(server)
      .get('/api/v1/products')
      .withAuth({ id: 'test', roles: ['admin'] })
      .send();
    expect(res.statusCode).toBe(200);
  });
});

// ─── 4. Resource CRUD + Permissions (Arc HttpTestHarness) ───────────────────────

// --- Branch: staff can read, admin can manage ---
import branchResource from '../modules/commerce/branch/branch.resource.js';
const branchHarness = createHttpTestHarness(branchResource, () => ({
  app: server,
  apiPrefix: '/api/v1',
  fixtures: {
    valid: { name: 'Test Branch', code: 'TEST-' + Date.now(), isDefault: false },
    update: { name: 'Updated Branch' },
  },
  auth,
}));
branchHarness.runCrud();
branchHarness.runPermissions();

// --- Coupon: admin only ---
import couponResource from '../modules/commerce/coupon/coupon.resource.js';
const couponHarness = createHttpTestHarness(couponResource, () => ({
  app: server,
  apiPrefix: '/api/v1',
  fixtures: {
    valid: {
      code: 'TEST' + Date.now(),
      discountType: 'percentage',
      discountAmount: 10,
      minOrderAmount: 100,
      isActive: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    update: { discountAmount: 20 },
  },
  auth,
}));
couponHarness.runCrud();
couponHarness.runPermissions();

// --- Category: public read, admin manage ---
import categoryResource from '../modules/catalog/categories/category.resource.js';
const categoryHarness = createHttpTestHarness(categoryResource, () => ({
  app: server,
  apiPrefix: '/api/v1',
  fixtures: {
    valid: { name: 'Test Category ' + Date.now(), description: 'Test' },
    update: { description: 'Updated' },
  },
  auth,
}));
categoryHarness.runCrud();

// --- Size Guide: public read, admin manage ---
import sizeGuideResource from '../modules/commerce/size-guide/size-guide.resource.js';
const sizeGuideHarness = createHttpTestHarness(sizeGuideResource, () => ({
  app: server,
  apiPrefix: '/api/v1',
  fixtures: {
    valid: { name: 'Test Size Guide ' + Date.now(), sizes: [] },
    update: { name: 'Updated Size Guide' },
  },
  auth,
}));
sizeGuideHarness.runCrud();

// --- Job: admin only ---
import jobResource from '../modules/job/job.resource.js';
const jobHarness = createHttpTestHarness(jobResource, () => ({
  app: server,
  apiPrefix: '/api/v1',
  fixtures: {
    valid: { type: 'TEST_JOB', data: { test: true }, status: 'pending' },
    update: { status: 'completed' },
  },
  auth,
}));
jobHarness.runCrud();
jobHarness.runPermissions();

// ─── 5. MongoKit CRUD ───────────────────────────────────────────────────────────

describe('MongoKit 3.3.2 CRUD', () => {
  it('should perform full CRUD cycle via repository', async () => {
    const { createRepository } = await import('@classytic/mongokit');
    const schema = new mongoose.Schema({ name: String, value: Number });
    const Model = mongoose.models.MkTest || mongoose.model('MkTest', schema);
    const repo = createRepository(Model);

    const doc = await repo.create({ name: 'test', value: 42 });
    expect(doc._id).toBeDefined();

    const found = await repo.getById(doc._id.toString());
    expect(found.value).toBe(42);

    const updated = await repo.update(doc._id.toString(), { value: 99 });
    expect(updated.value).toBe(99);

    const result = await repo.delete(doc._id.toString());
    expect(result.success).toBe(true);

    await Model.deleteMany({});
  });
});

// ─── 6. Mongoose returnDocument ─────────────────────────────────────────────────

describe('Mongoose returnDocument', () => {
  it('returnDocument: after returns updated doc', async () => {
    const schema = new mongoose.Schema({ counter: { type: Number, default: 0 } });
    const Model = mongoose.models.RetDocTest || mongoose.model('RetDocTest', schema);
    const doc = await Model.create({ counter: 0 });
    const updated = await Model.findByIdAndUpdate(
      doc._id,
      { $inc: { counter: 1 } },
      { returnDocument: 'after' }
    );
    expect(updated.counter).toBe(1);
    await Model.deleteMany({});
  });
});

// ─── 7. Media-Kit ───────────────────────────────────────────────────────────────

describe('Media-Kit 2.1.0', () => {
  it('should create a valid schema', async () => {
    const { createMedia } = await import('@classytic/media-kit');
    const mockDriver = {
      write: async () => ({ key: 'test', url: 'http://test' }),
      read: async () => new ReadableStream(),
      delete: async () => true,
      exists: async () => false,
      stat: async () => ({ size: 0, lastModified: new Date() }),
      getPublicUrl: () => 'http://test',
    };
    const media = createMedia({ driver: mockDriver });
    expect(media.schema instanceof mongoose.Schema).toBe(true);
    const paths = Object.keys(media.schema.paths);
    expect(paths).toContain('filename');
    expect(paths).toContain('mimeType');
  });
});

// ─── 8. Arc Exports ─────────────────────────────────────────────────────────────

describe('Arc 2.3.0 exports', () => {
  it('core', async () => {
    const { defineResource, createMongooseAdapter, BaseController, ArcError } = await import('@classytic/arc');
    expect(typeof defineResource).toBe('function');
    expect(typeof createMongooseAdapter).toBe('function');
    expect(typeof BaseController).toBe('function');
    expect(ArcError).toBeDefined();
  });

  it('factory', async () => {
    const { createApp } = await import('@classytic/arc/factory');
    expect(typeof createApp).toBe('function');
  });

  it('events', async () => {
    const { eventPlugin, MemoryEventTransport, createEvent } = await import('@classytic/arc/events');
    expect(typeof eventPlugin).toBe('function');
    expect(MemoryEventTransport).toBeDefined();
    expect(typeof createEvent).toBe('function');
  });

  it('permissions', async () => {
    const { allowPublic, requireAuth, requireRoles, anyOf, allOf } = await import('@classytic/arc/permissions');
    for (const fn of [allowPublic, requireAuth, requireRoles, anyOf, allOf]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('testing', async () => {
    const t = await import('@classytic/arc/testing');
    for (const name of ['createTestApp', 'request', 'createTestAuth', 'createJwtAuthProvider', 'createHttpTestHarness']) {
      expect(typeof t[name]).toBe('function');
    }
  });
});

// ─── 9. createTestApp standalone ────────────────────────────────────────────────

describe('Arc createTestApp', () => {
  let testApp;

  beforeAll(async () => {
    testApp = await createTestApp({
      useInMemoryDb: false,
      mongoUri: globalThis.__MONGO_URI__,
    });
  }, 30000);

  afterAll(async () => {
    if (testApp) await testApp.close();
  });

  it('should create app with testing preset', () => {
    expect(testApp.app).toBeDefined();
  });

  it('should have JWT and events by default', () => {
    expect(testApp.app.jwt).toBeDefined();
    expect(testApp.app.events).toBeDefined();
  });
});
