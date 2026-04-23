/**
 * Current-stack migration verification smoke tests.
 *
 * This suite validates that the post-migration app still boots, auth works
 * with Better Auth bearer tokens, key resources are reachable, and core
 * library integrations still behave as expected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { waitFor } from '@classytic/arc/testing';

let server;
let adminToken = '';
let userToken = '';

function parseBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function authHeaders(token, orgId) {
  const headers = { authorization: `Bearer ${token}` };
  if (orgId) headers['x-organization-id'] = orgId;
  return headers;
}

async function signUp(email, password, name) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  return parseBody(res.body);
}

async function signIn(email, password) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  return parseBody(res.body);
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  if (globalThis.__MONGO_URI__) {
    process.env.MONGO_URI = globalThis.__MONGO_URI__;
  }

  const { loadTestResources } = await import('./setup/preload-resources.js');
  const { resources } = await loadTestResources();
  const { createApplication } = await import('../src/app.js');
  server = await createApplication({ resources });
  await server.ready();

  const adminSignup = await signUp('migration-admin@test.com', 'password123456', 'Migration Admin');
  await mongoose.connection.getClient().db().collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(adminSignup?.user?.id) },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  adminToken = signIn('migration-admin@test.com', 'password123456').then((body) => body?.token || '');

  await signUp('migration-user@test.com', 'password123456', 'Migration User');
  userToken = signIn('migration-user@test.com', 'password123456').then((body) => body?.token || '');

  adminToken = await adminToken;
  userToken = await userToken;
}, 60000);

afterAll(async () => {
  if (server) await server.close();
});

describe('App bootstrap', () => {
  it('boots successfully', () => {
    expect(server).toBeDefined();
  });

  it('serves health', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Arc events', () => {
  it('has the event API decorated', () => {
    expect(server.events).toBeDefined();
    expect(typeof server.events.publish).toBe('function');
    expect(typeof server.events.subscribe).toBe('function');
  });

  it('publishes and subscribes', async () => {
    const received = [];
    const unsub = await server.events.subscribe('test.harness', (e) => received.push(e));
    await server.events.publish('test.harness', { ok: true });
    await waitFor(() => received.length > 0, { timeout: 2000 });
    expect(received[0].payload).toEqual({ ok: true });
    if (typeof unsub === 'function') unsub();
  });

  it('works through the arcEvents wrapper', async () => {
    const { publish, subscribe } = await import('../src/lib/events/arcEvents.js');
    const received = [];
    const unsub = await subscribe('test.wrapper', (e) => received.push(e));
    await publish('test.wrapper', { wrapped: true });
    await waitFor(() => received.length > 0, { timeout: 2000 });
    expect(received[0].payload).toEqual({ wrapped: true });
    if (typeof unsub === 'function') unsub();
  });
});

describe('Better Auth', () => {
  it('signs in and returns a bearer token', () => {
    expect(typeof adminToken).toBe('string');
    expect(adminToken.length).toBeGreaterThan(20);
  });

  it('rejects unauthenticated branch access', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/branches' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts authenticated product access', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: authHeaders(adminToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps basic user tokens valid for protected routes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: authHeaders(userToken),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Resource smoke', () => {
  it('lists branches for admin', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/branches',
      headers: authHeaders(adminToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it('lists categories publicly', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(res.statusCode).toBe(200);
  });

  it('creates a category for admin', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: authHeaders(adminToken),
      payload: { name: `Migration Category ${Date.now()}` },
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  it('creates a size guide for admin', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: authHeaders(adminToken),
      payload: {
        name: `Migration Size Guide ${Date.now()}`,
        sizes: [{ name: 'M', measurements: { chest: '40' } }],
      },
    });
    expect(res.statusCode).toBeLessThan(300);
  });
});

describe('Library integrations', () => {
  it('performs a Mongokit CRUD cycle', async () => {
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

  it('supports returnDocument: after', async () => {
    const schema = new mongoose.Schema({ counter: { type: Number, default: 0 } });
    const Model = mongoose.models.RetDocTest || mongoose.model('RetDocTest', schema);
    const doc = await Model.create({ counter: 0 });
    const updated = await Model.findByIdAndUpdate(
      doc._id,
      { $inc: { counter: 1 } },
      { returnDocument: 'after' },
    );
    expect(updated.counter).toBe(1);
    await Model.deleteMany({});
  });

  it('creates a valid media-kit schema', async () => {
    // media-kit 3.0 moved schema construction to `buildMediaSchema()` — no
    // connection / driver needed to verify the shape. `createMedia()` now
    // requires a full MediaConfig with `connection` + `driver`; the smoke
    // test only cares that the schema factory produces a Mongoose Schema.
    const { buildMediaSchema } = await import('@classytic/media-kit');
    const schema = buildMediaSchema();
    expect(schema instanceof mongoose.Schema).toBe(true);
  });
});

describe('Arc exports', () => {
  it('exposes core and testing APIs', async () => {
    const arc = await import('@classytic/arc');
    const factory = await import('@classytic/arc/factory');
    const events = await import('@classytic/arc/events');
    const testing = await import('@classytic/arc/testing');

    expect(typeof arc.defineResource).toBe('function');
    expect(typeof factory.createApp).toBe('function');
    expect(typeof events.eventPlugin).toBe('function');
    expect(typeof testing.request).toBe('function');
    expect(typeof testing.createTestAuth).toBe('function');
  });
});
