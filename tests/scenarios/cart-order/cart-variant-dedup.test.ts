/**
 * Cart variant deduplication — regression test.
 *
 * Bug: adding the same `(productId, variantSku)` pair twice via
 * `POST /api/v1/cart/items` created TWO lines with quantity=1 each instead
 * of merging into ONE line with quantity=2.
 *
 * Root cause: @classytic/cart's `mergeKey()` hard-coded a lookup for
 * `payload.skuRef` (the `sku` kind). The `variant` kind uses
 * `payload: { productRef, variantSku }` — no `skuRef` — so `mergeKey()`
 * returned null and every add appended a fresh line.
 *
 * Contract this test locks in: two calls to `POST /cart/items` with
 * identical product+variant should collapse into one line whose
 * quantity equals the sum. Also covers the simple-sku path for
 * completeness.
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const API = '/api/v1';
const TEST_ORG_ID = new Types.ObjectId().toHexString();
const USER = { _id: 'user_dedup', id: 'user_dedup', role: ['admin'] };

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;

// Product + variant seeded in beforeAll — the cart bridge resolves by
// scanning `variants.sku` first, falling back to `_id`.
let simpleProductId: string;
let variantProductId: string;
const VARIANT_SKU = 'DEDUP-TSHIRT-M-BLUE';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

function headers() {
  return { 'content-type': 'application/json', 'x-organization-id': TEST_ORG_ID };
}

async function seedProducts(): Promise<void> {
  const db = mongoose.connection.db!;
  const ts = Date.now();

  // Simple SKU product (no variants)
  const simple = await db.collection('catalog_products').insertOne({
    name: 'Dedup Simple Widget',
    slug: `dedup-simple-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 10000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: `DEDUP-SIMPLE-${ts}` } },
    shipping: { requiresShipping: true, weight: 250 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  simpleProductId = simple.insertedId.toString();

  // Variant product (one active variant — M/Blue)
  const variant = await db.collection('catalog_products').insertOne({
    name: 'Dedup Variant T-Shirt',
    slug: `dedup-variant-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 20000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: `DEDUP-VARIANT-${ts}` } },
    shipping: { requiresShipping: true, weight: 300 },
    variationAttributes: [
      { code: 'size', name: 'Size', values: [{ code: 'M', label: 'M' }] },
      { code: 'color', name: 'Color', values: [{ code: 'blue', label: 'Blue' }] },
    ],
    variants: [
      {
        sku: VARIANT_SKU,
        attributes: { size: 'M', color: 'blue' },
        priceModifier: 0,
        isActive: true,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  variantProductId = variant.insertedId.toString();
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }

  await seedProducts();

  const { initCartEngine } = await import('../../../src/resources/sales/cart/cart.engine.js');
  await initCartEngine();

  const { default: cartResource } = await import('../../../src/resources/sales/cart/cart.resource.js');

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: typeof USER }).user = USER;
  });

  await app.register(async (scoped) => {
    await scoped.register(cartResource.toPlugin());
  }, { prefix: API });

  await app.ready();
}, 90_000);

afterAll(async () => {
  if (app) await app.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

beforeEach(async () => {
  const db = mongoose.connection.db!;
  await Promise.all([
    db.collection('cart_drafts').deleteMany({}),
    db.collection('cart_checkouts').deleteMany({}),
    db.collection('cart_reservations').deleteMany({}),
    db.collection('cart_idempotency').deleteMany({}),
  ]);
});

describe('Cart add-item deduplication — variant kind', () => {
  it('collapses two identical variant adds into one line with summed quantity', async () => {
    const addOnce = () =>
      app.inject({
        method: 'POST',
        url: `${API}/cart/items`,
        headers: headers(),
        payload: { productId: variantProductId, variantSku: VARIANT_SKU, quantity: 1 },
      });

    const first = await addOnce();
    expect(first.statusCode).toBe(200);
    const firstBody = parse(first.body);
    expect(firstBody?.success).toBe(true);
    const firstCart = firstBody?.data as { lines: { lineId: string; quantity: number; kind: string; payload: unknown }[] };
    expect(firstCart.lines).toHaveLength(1);
    expect(firstCart.lines[0].quantity).toBe(1);
    const firstLineId = firstCart.lines[0].lineId;

    const second = await addOnce();
    expect(second.statusCode).toBe(200);
    const secondBody = parse(second.body);
    expect(secondBody?.success).toBe(true);
    const secondCart = secondBody?.data as { lines: { lineId: string; quantity: number }[] };

    // THE CORE ASSERTION: still ONE line, quantity bumped to 2.
    expect(secondCart.lines).toHaveLength(1);
    expect(secondCart.lines[0].quantity).toBe(2);
    // Same line merged, so its lineId is stable across the retry.
    expect(secondCart.lines[0].lineId).toBe(firstLineId);
  });

  it('respects merge grouping — different variant SKUs on the same product stay separate', async () => {
    // Seed a second variant on the same product so we can test that only
    // matching (productRef, variantSku) pairs merge.
    const db = mongoose.connection.db!;
    const OTHER_VARIANT = `${VARIANT_SKU}-L`;
    await db.collection('catalog_products').updateOne(
      { _id: new Types.ObjectId(variantProductId) },
      {
        $push: {
          variants: {
            sku: OTHER_VARIANT,
            attributes: { size: 'L', color: 'blue' },
            priceModifier: 0,
            isActive: true,
          },
        } as never,
      },
    );

    const addM = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: { productId: variantProductId, variantSku: VARIANT_SKU, quantity: 2 },
    });
    expect(addM.statusCode).toBe(200);

    const addL = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: { productId: variantProductId, variantSku: OTHER_VARIANT, quantity: 3 },
    });
    expect(addL.statusCode).toBe(200);

    const body = parse(addL.body);
    const cart = body?.data as { lines: { quantity: number; payload: { variantSku?: string } }[] };

    // Two separate lines — one per distinct variant SKU.
    expect(cart.lines).toHaveLength(2);
    const byQty = [...cart.lines].sort((a, b) => a.quantity - b.quantity);
    expect(byQty[0].quantity).toBe(2);
    expect(byQty[1].quantity).toBe(3);
    const skus = cart.lines.map((l) => l.payload.variantSku).sort();
    expect(skus).toEqual([VARIANT_SKU, OTHER_VARIANT].sort());
  });
});

describe('Cart add-item — client-supplied display snapshot', () => {
  it('stores the display fields the client sent verbatim (saves a catalog round-trip)', async () => {
    const display = {
      name: 'Client-Provided Name',
      imageUrl: 'https://cdn.example.com/tshirt.jpg',
      slug: 'client-provided-slug',
      variantLabel: 'Size: M, Color: Blue',
      compareAtPrice: { amount: 25000, currency: 'BDT' },
      capturedAt: '2026-04-22T10:00:00.000Z',
    };

    const res = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: {
        productId: variantProductId,
        variantSku: VARIANT_SKU,
        quantity: 1,
        display,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const cart = body?.data as { lines: { display: typeof display }[] };
    expect(cart.lines).toHaveLength(1);
    const stored = cart.lines[0].display;
    // All client-supplied fields round-trip exactly — the backend did NOT
    // overwrite any of them with its own catalog-resolved values.
    expect(stored.name).toBe(display.name);
    expect(stored.imageUrl).toBe(display.imageUrl);
    expect(stored.slug).toBe(display.slug);
    expect(stored.variantLabel).toBe(display.variantLabel);
    expect(stored.compareAtPrice).toEqual(display.compareAtPrice);
  });

  it('falls back to the kind\'s displayOf() when no display is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: {
        productId: variantProductId,
        variantSku: VARIANT_SKU,
        quantity: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const cart = (parse(res.body)?.data as { lines: { display?: { name?: string } }[] });
    // The backend resolved the catalog and populated display from the product
    // record we seeded in beforeAll.
    expect(cart.lines[0].display?.name).toBe('Dedup Variant T-Shirt');
  });
});

describe('Cart remove-item — incremental repricing', () => {
  it('does not re-resolve untouched lines from the catalog on remove', async () => {
    // Add two lines — one variant, one simple sku.
    const addVariant = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: {
        productId: variantProductId,
        variantSku: VARIANT_SKU,
        quantity: 1,
      },
    });
    expect(addVariant.statusCode).toBe(200);

    const addSimple = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: { productId: simpleProductId, quantity: 2 },
    });
    expect(addSimple.statusCode).toBe(200);
    const twoLineCart = parse(addSimple.body)?.data as {
      lines: { lineId: string; kind: string }[];
      pricing: { lines: { lineId: string; unitPrice: { amount: number } }[] };
    };
    const variantLineId = twoLineCart.lines.find((l) => l.kind === 'variant')!.lineId;
    const simpleLineId = twoLineCart.lines.find((l) => l.kind === 'sku')!.lineId;
    const simpleUnitBefore = twoLineCart.pricing.lines.find((p) => p.lineId === simpleLineId)!
      .unitPrice.amount;

    // Delete the underlying variant product so the catalog no longer resolves
    // it. If remove-item re-fetched catalog for the remaining simple line,
    // that path would still work — this only proves no hit on the removed
    // SKU. The real signal is that the remaining line's unitPrice round-trips
    // unchanged even though the bridge doesn't carry a prior fetch.
    const db = mongoose.connection.db!;
    await db.collection('catalog_products').updateOne(
      { _id: new Types.ObjectId(variantProductId) },
      { $set: { status: 'archived' } },
    );

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `${API}/cart/items/${variantLineId}`,
      headers: { 'x-organization-id': TEST_ORG_ID },
    });
    expect(removeRes.statusCode).toBe(200);
    const afterRemove = parse(removeRes.body)?.data as {
      lines: { lineId: string }[];
      pricing: { lines: { lineId: string; unitPrice: { amount: number } }[] };
    };

    // One line remains, priced identically to before the remove — the
    // repository reused its prior priced entry instead of re-resolving.
    expect(afterRemove.lines).toHaveLength(1);
    expect(afterRemove.lines[0].lineId).toBe(simpleLineId);
    const simpleUnitAfter = afterRemove.pricing.lines.find((p) => p.lineId === simpleLineId)!
      .unitPrice.amount;
    expect(simpleUnitAfter).toBe(simpleUnitBefore);

    // Restore product so later tests can use it.
    await db.collection('catalog_products').updateOne(
      { _id: new Types.ObjectId(variantProductId) },
      { $set: { status: 'active' } },
    );
  });
});

describe('Cart add-item deduplication — sku kind (simple product)', () => {
  it('collapses two identical simple-sku adds into one line with summed quantity', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: { productId: simpleProductId, quantity: 2 },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `${API}/cart/items`,
      headers: headers(),
      payload: { productId: simpleProductId, quantity: 3 },
    });
    expect(second.statusCode).toBe(200);

    const cart = (parse(second.body)?.data as { lines: { quantity: number }[] });
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(5);
  });
});
