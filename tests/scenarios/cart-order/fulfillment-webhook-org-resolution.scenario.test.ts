/**
 * Fulfillment webhook — organization resolution from the fulfillment itself.
 *
 * Problem this test pins:
 *   Carrier webhooks (RedX / Pathao / Steadfast) land on
 *   `POST /api/v1/logistics/webhooks/:provider` WITHOUT an
 *   `x-organization-id` header — carriers don't know about our branches.
 *   Tracking numbers are globally unique per carrier, so the handler must
 *   look the fulfillment up WITHOUT an org filter, derive the correct
 *   `organizationId` from the fulfillment document, and apply any FSM
 *   transition in THAT branch's context.
 *
 * Scenarios covered:
 *   1. Webhook arrives with NO `x-organization-id` → status transitions.
 *   2. Webhook arrives with a WRONG / spoofed org header → status still
 *      transitions because the handler resolves org from the fulfillment,
 *      not the header.
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let server: FastifyInstance;
let adminAuth: TestAuthProvider;
let orgId: string;

let productId: string;
let productSku: string;

const adminHeaders = () => ({ ...adminAuth.as('admin').headers, 'x-organization-id': orgId });

async function seedStock(skuRef: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, skuRef, qty, 5000);
}

async function getFulfillmentStatus(fulNumber: string, forOrderNumber: string): Promise<string | null> {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/fulfillments/for-order/${forOrderNumber}`,
    headers: adminHeaders(),
  });
  if (res.statusCode >= 400) return null;
  const body = parse(res.body) as Record<string, unknown> | null;
  // Handler spreads mongokit pagination at top level — `docs` sibling of
  // `success`, NOT under `data` (matches arc-next list convention).
  const list = (body?.data as Array<Record<string, unknown>> | undefined) ?? [];
  const match = list.find((f) => f.fulfillmentNumber === fulNumber);
  return (match?.status as string) ?? null;
}

async function placeOrderAndFulfill(idempotencyKey: string): Promise<{
  orderNumber: string;
  fulfillmentNumber: string;
}> {
  const orderRes = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: adminHeaders(),
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: productId,
          quantity: 1,
          unitPriceOverride: { amount: 50000, currency: 'BDT' },
        },
      ],
      customer: { email: 'buyer@test.com', name: 'Test Customer' },
      idempotencyKey,
    },
  });
  if (orderRes.statusCode >= 400) {
    throw new Error(`Order place failed: ${orderRes.statusCode} ${orderRes.body}`);
  }
  const newOrderNumber = ((parse(orderRes.body) as Record<string, unknown>)
    ?.orderNumber) as string;

  const fulRes = await server.inject({
    method: 'POST',
    url: `${API}/fulfillments/for-order/${newOrderNumber}`,
    headers: adminHeaders(),
    payload: {
      fulfillmentType: 'physical',
      lines: [{ orderLineId: 'line_0', quantity: 1 }],
    },
  });
  if (fulRes.statusCode >= 400) {
    throw new Error(`Fulfillment create failed: ${fulRes.statusCode} ${fulRes.body}`);
  }
  const newFulNumber = ((parse(fulRes.body) as Record<string, unknown>)
    ?.fulfillmentNumber) as string;

  // Advance pick → pack → ship (admin).
  for (const action of ['pick', 'pack', 'ship']) {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${newFulNumber}/action`,
      headers: adminHeaders(),
      payload: { action },
    });
    if (res.statusCode >= 400) {
      throw new Error(`Advance '${action}' failed: ${res.statusCode} ${res.body}`);
    }
  }

  return { orderNumber: newOrderNumber, fulfillmentNumber: newFulNumber };
}

async function attachTracking(fulfillmentNumber: string, trackingNumber: string): Promise<void> {
  const res = await server.inject({
    method: 'PATCH',
    url: `${API}/fulfillments/${fulfillmentNumber}/tracking`,
    headers: adminHeaders(),
    payload: { carrier: 'redx', trackingNumber, trackingUrl: 'https://redx.com.bd/track' },
  });
  if (res.statusCode >= 400) {
    throw new Error(`Tracking attach failed: ${res.statusCode} ${res.body}`);
  }
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'webhook-org',
    env: { REDX_API_KEY: 'test-key-for-ingest' },
  });
  server = env.server;
  adminAuth = env.auth;
  orgId = env.orgId;

  const ts = Date.now();
  productSku = `WEBHOOK-ORG-SKU-${ts}`;

  const db = mongoose.connection.db!;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Webhook Org Product',
    slug: `webhook-org-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 50000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: productSku } },
    shipping: { requiresShipping: true, weight: 250 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  productId = prod.insertedId.toString();

  // Simple products (no variants) resolve to skuRef = productId via CatalogBridge.
  await seedStock(productId, 20);
}, 180_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

describe('Fulfillment webhook — org resolved from the fulfillment, not the header', () => {
  it('transitions to delivered when carrier POSTs WITHOUT x-organization-id', async () => {
    const ts = Date.now();
    const { orderNumber, fulfillmentNumber } = await placeOrderAndFulfill(`webhook-noorg-${ts}`);
    const trackingNumber = `REDX-NOORG-${ts}`;
    await attachTracking(fulfillmentNumber, trackingNumber);

    // Carrier production payload — no x-organization-id, no auth.
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/webhooks/redx`,
      headers: {
        // Intentionally NO x-organization-id. Carriers don't send it.
      },
      payload: {
        tracking_number: trackingNumber,
        status: 'delivered',
        message_en: 'Parcel delivered to recipient',
        timestamp: new Date().toISOString(),
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await getFulfillmentStatus(fulfillmentNumber, orderNumber)).toBe('delivered');
  });

  it('transitions to delivered when header org is empty string', async () => {
    const ts = Date.now() + 1;
    const { orderNumber, fulfillmentNumber } = await placeOrderAndFulfill(`webhook-emptyorg-${ts}`);
    const trackingNumber = `REDX-EMPTY-${ts}`;
    await attachTracking(fulfillmentNumber, trackingNumber);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/webhooks/redx`,
      headers: { 'x-organization-id': '' },
      payload: {
        tracking_number: trackingNumber,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await getFulfillmentStatus(fulfillmentNumber, orderNumber)).toBe('delivered');
  });

  it('resolves org from fulfillment even when header targets a different branch', async () => {
    const ts = Date.now() + 2;
    const { orderNumber, fulfillmentNumber } = await placeOrderAndFulfill(`webhook-wrongorg-${ts}`);
    const trackingNumber = `REDX-WRONG-${ts}`;
    await attachTracking(fulfillmentNumber, trackingNumber);

    // Fabricate a plausible-looking (but different) ObjectId as the header.
    const bogusOrgId = new mongoose.Types.ObjectId().toString();
    expect(bogusOrgId).not.toBe(orgId);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/webhooks/redx`,
      headers: { 'x-organization-id': bogusOrgId },
      payload: {
        tracking_number: trackingNumber,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    // The transition uses the fulfillment's OWN organizationId, so the real
    // branch's admin can still see the delivered status.
    expect(await getFulfillmentStatus(fulfillmentNumber, orderNumber)).toBe('delivered');
  });
});
