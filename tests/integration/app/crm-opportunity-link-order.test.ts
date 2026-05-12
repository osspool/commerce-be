/**
 * CRM opportunity linkOrder — integration test (gap #18)
 *
 * Gap: opportunities have no way to associate with a sales order.
 * Fix: add a `linkOrder` action on opportunity resource that persists
 *      metadata.orderId and metadata.orderLinkedAt.
 *
 * RED: fails until the action is added to opportunity.resource.ts
 * GREEN: add `linkOrder` action + handler
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
const API = '/api/v1';
const h = () => env.auth.as('admin').headers;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'crm-opp-link' });
}, 90_000);

afterAll(async () => {
  await env.teardown();
});

async function createOpportunity(): Promise<string> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/crm/opportunities`,
    headers: h(),
    payload: {
      name: 'Test Deal',
      pipelineId: 'pipe-1',
      stageId: 'stage-1',
      probability: 0.5,
    },
  });
  expect(res.statusCode, `create opp: ${res.body}`).toBe(201);
  const body = parse(res.body) as Record<string, unknown>;
  return (body._id ?? body.id) as string;
}

describe('POST /crm/opportunities/:id/action — linkOrder (gap #18)', () => {
  it('links an order to an opportunity and persists metadata.orderId', async () => {
    const oppId = await createOpportunity();

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/crm/opportunities/${oppId}/action`,
      headers: h(),
      payload: { action: 'linkOrder', orderId: 'ORD-12345' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const updated = parse(res.body) as Record<string, unknown>;
    const meta = updated.metadata as Record<string, unknown> | undefined;
    expect(meta?.orderId).toBe('ORD-12345');
    expect(meta?.orderLinkedAt).toBeDefined();
  });

  it('returns 400 when orderId is missing', async () => {
    const oppId = await createOpportunity();

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/crm/opportunities/${oppId}/action`,
      headers: h(),
      payload: { action: 'linkOrder' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('preserves existing metadata fields when linking order', async () => {
    const oppId = await createOpportunity();

    // Pre-seed metadata via direct PATCH
    await env.server.inject({
      method: 'PATCH',
      url: `${API}/crm/opportunities/${oppId}`,
      headers: h(),
      payload: { metadata: { source: 'web', campaign: 'q1-promo' } },
    });

    // Link order
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/crm/opportunities/${oppId}/action`,
      headers: h(),
      payload: { action: 'linkOrder', orderId: 'ORD-99' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const updated = parse(res.body) as Record<string, unknown>;
    const meta = updated.metadata as Record<string, unknown> | undefined;
    // Order link is added
    expect(meta?.orderId).toBe('ORD-99');
    // Existing keys survive
    expect(meta?.source).toBe('web');
    expect(meta?.campaign).toBe('q1-promo');
  });
});
