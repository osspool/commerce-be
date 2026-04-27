/**
 * Size Guide resource integration test — bare-Fastify + Arc adapter.
 *
 * Covers the CRUD-by-adapter contract plus the slug-lookup preset:
 *   GET    /size-guides            → public list
 *   GET    /size-guides/:id        → public get
 *   GET    /size-guides/slug/:slug → public lookup (slugLookup preset)
 *   POST   /size-guides            → admin create (auto-slug from name)
 *   PATCH  /size-guides/:id        → admin update
 *   DELETE /size-guides/:id        → admin delete
 *
 * Auth gate: writes require platformAdminOnly() (user.role contains 'admin'
 * or 'superadmin'). Reads are public — no user attached at all.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import sizeGuideResource from '../../../src/resources/commerce/size-guide/size-guide.resource.js';

let app: FastifyInstance;
let adminApp: FastifyInstance;
let publicApp: FastifyInstance;

const ADMIN_USER = { _id: 'sg-admin', id: 'sg-admin', role: ['admin'] };

beforeAll(async () => {
  // Two app instances — one with admin auth (writes), one anonymous (reads).
  // Cheaper than wiring Better Auth for a CRUD smoke test.
  adminApp = Fastify({ logger: false });
  adminApp.addHook('onRequest', async (req) => {
    (req as unknown as { user: typeof ADMIN_USER }).user = ADMIN_USER;
  });
  await adminApp.register(
    async (scoped) => {
      await scoped.register(sizeGuideResource.toPlugin());
    },
    { prefix: '/api/v1' },
  );
  await adminApp.ready();

  publicApp = Fastify({ logger: false });
  await publicApp.register(
    async (scoped) => {
      await scoped.register(sizeGuideResource.toPlugin());
    },
    { prefix: '/api/v1' },
  );
  await publicApp.ready();

  app = adminApp;
}, 30_000);

afterAll(async () => {
  await adminApp?.close();
  await publicApp?.close();
}, 10_000);

beforeEach(async () => {
  await mongoose.connection.collection('sizeguides').deleteMany({});
});

const json = { 'content-type': 'application/json' };

describe('Size Guide CRUD', () => {
  it('admin can create a size guide; slug auto-generated from name', async () => {
    const res = await adminApp.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: json,
      payload: {
        name: 'T-Shirts & Tops',
        measurementUnit: 'inches',
        measurementLabels: ['Chest', 'Length'],
        sizes: [
          { name: 'S', measurements: { Chest: '36-38', Length: '27' } },
          { name: 'M', measurements: { Chest: '38-40', Length: '28' } },
        ],
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();
    expect(body.success).toBe(true);
    // slug plugin transliterates "&" → "and"
    expect(body.data.slug).toMatch(/^t-shirts(-and)?-tops$/);
    expect(body.data.sizes).toHaveLength(2);
  });

  it('public list returns active size guides without auth', async () => {
    await mongoose.connection.collection('sizeguides').insertOne({
      name: 'Public Guide',
      slug: 'public-guide',
      measurementUnit: 'cm',
      measurementLabels: ['Waist'],
      sizes: [{ name: '32', measurements: { Waist: '81' } }],
      isActive: true,
      displayOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await publicApp.inject({ method: 'GET', url: '/api/v1/size-guides' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Arc paginated list: { data: [...], total } or { data: { docs: [...] } }
    const docs = Array.isArray(body.data) ? body.data : (body.data?.docs ?? body.docs);
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /size-guides/slug/:slug resolves a guide by slug (preset route)', async () => {
    await mongoose.connection.collection('sizeguides').insertOne({
      name: 'Hoodie Guide',
      slug: 'hoodie-guide',
      measurementUnit: 'inches',
      measurementLabels: ['Chest'],
      sizes: [{ name: 'L', measurements: { Chest: '42-44' } }],
      isActive: true,
      displayOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await publicApp.inject({
      method: 'GET',
      url: '/api/v1/size-guides/slug/hoodie-guide',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('hoodie-guide');
    expect(body.data.name).toBe('Hoodie Guide');
  });

  it('admin can update a guide; updateOnChange regenerates slug from new name', async () => {
    const created = await adminApp.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: json,
      payload: {
        name: 'Original Name',
        measurementUnit: 'cm',
        sizes: [{ name: 'One', measurements: {} }],
      },
    });
    const id = created.json().data._id;

    const res = await adminApp.inject({
      method: 'PATCH',
      url: `/api/v1/size-guides/${id}`,
      headers: json,
      payload: { name: 'Renamed Guide' },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();
    expect(body.data.name).toBe('Renamed Guide');
    expect(body.data.slug).toBe('renamed-guide');
  });

  it('admin can delete a guide', async () => {
    const created = await adminApp.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: json,
      payload: {
        name: 'To Delete',
        measurementUnit: 'cm',
        sizes: [{ name: 'One', measurements: {} }],
      },
    });
    const id = created.json().data._id;

    const res = await adminApp.inject({ method: 'DELETE', url: `/api/v1/size-guides/${id}` });
    expect(res.statusCode).toBeLessThan(300);

    const after = await adminApp.inject({ method: 'GET', url: `/api/v1/size-guides/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it('write without admin auth is rejected', async () => {
    const res = await publicApp.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: json,
      payload: {
        name: 'Should Fail',
        measurementUnit: 'cm',
        sizes: [{ name: 'One', measurements: {} }],
      },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('Size Guide validation', () => {
  it('rejects creation without required name', async () => {
    const res = await adminApp.inject({
      method: 'POST',
      url: '/api/v1/size-guides',
      headers: json,
      payload: {
        measurementUnit: 'cm',
        sizes: [{ name: 'One', measurements: {} }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
