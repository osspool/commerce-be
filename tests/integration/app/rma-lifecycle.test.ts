/**
 * RMA lifecycle integration test.
 *
 * Covers:
 *   1. Full HTTP lifecycle: request → approve → mark_received → inspect → resolve
 *   2. Timeline endpoint returns ordered audit trail
 *   3. Terminal-state guard: reject on a resolved RMA returns 422
 *   4. period-close validate_open_returns gate blocks when open RMAs exist,
 *      then passes once they are gone
 *
 * Uses `bootScenarioApp` for a full Arc app + MongoMemoryReplSet.
 * The admin user has role=['admin'] which satisfies platformAdminOnly() and
 * therefore passes returnCreate / returnManage / returnInspect gates.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv, parse } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;

// Persisted across tests — sequential lifecycle.
let rmaId: string;
let rmaNumber: string;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'rma-lifecycle' });
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

// ─── 1. RMA Lifecycle (HTTP) ──────────────────────────────────────────────────

describe('RMA lifecycle (HTTP)', () => {
  it('POST /rmas creates an RMA in requested state', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas`,
      headers: env.auth.as('admin').headers,
      payload: {
        orderId: new mongoose.Types.ObjectId().toString(),
        orderNumber: 'ORD-TEST-001',
        customerId: 'CUST-001',
        currency: 'BDT',
        lines: [
          {
            lineId: 'line-1',
            orderLineId: 'ol-1',
            skuRef: 'SKU-001',
            unitCount: 2,
            unitRefundPaisa: 50_00,
            reason: 'defective',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body).not.toBeNull();
    rmaId = body?._id as string;
    rmaNumber = body?.rmaNumber as string;
    expect(rmaNumber).toMatch(/^RMA-\d{4}-/);
    expect(body?.state).toBe('requested');
  });

  it('GET /rmas/:id returns the created RMA', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/rmas/${rmaId}`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?._id).toBe(rmaId);
  });

  it('GET /rmas lists RMAs (pagination shape)', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/rmas`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    // Arc paginated list — data array present
    expect(Array.isArray(body?.data)).toBe(true);
    expect((body?.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('approve action → state:approved', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas/${rmaId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.state).toBe('approved');
  });

  it('mark_received action → state:received', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas/${rmaId}/action`,
      headers: env.auth.as('admin').headers,
      payload: {
        action: 'mark_received',
        lines: [{ lineId: 'line-1', unitCountReceived: 2 }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.state).toBe('received');
  });

  it('inspect action → state:inspected', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas/${rmaId}/action`,
      headers: env.auth.as('admin').headers,
      payload: {
        action: 'inspect',
        lines: [{ lineId: 'line-1', unitCountAccepted: 2, disposition: 'scrap' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.state).toBe('inspected');
  });

  it('resolve action → state:resolved', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas/${rmaId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'resolve', resolution: 'refund' },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.state).toBe('resolved');
  });

  it('GET /rmas/:id/timeline returns an audit trail with at least 5 entries', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/rmas/${rmaId}/timeline`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(Array.isArray(body?.data)).toBe(true);
    // requested → approved → received → inspected → resolved = at least 5 events
    expect((body?.data as unknown[]).length).toBeGreaterThanOrEqual(5);
    expect(body?.rmaNumber).toBe(rmaNumber);
  });

  it('reject action on a terminal RMA returns 422', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/rmas/${rmaId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'reject', reason: 'Late reject attempt' },
    });
    expect(res.statusCode).toBe(422);
  });
});

// ─── 2. Period-close: validate_open_returns gate ──────────────────────────────

describe('Period-close: validate_open_returns gate', () => {
  let sessionId: string;

  beforeAll(async () => {
    // Seed a FiscalPeriod covering the current month so the date filter
    // matches RMA documents created with `new Date()`.
    const { FiscalPeriod } = await import(
      '../../../src/resources/accounting/accounting.engine.js'
    );
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const period = await (FiscalPeriod as mongoose.Model<{ startDate: Date; endDate: Date; name: string; closed: boolean }>).create({
      name: 'RMA-Gate Test Period',
      startDate: start,
      endDate: end,
      closed: false,
    });

    // Create a PeriodCloseSession with currentStepIndex pointing at
    // validate_open_returns (index 10), all prior steps pre-marked as
    // success to skip the accounting / POS / stock gates.
    const { DEFAULT_PERIOD_CLOSE_STEPS, PeriodCloseSession } = await import(
      '../../../src/resources/accounting/period-close/period-close.model.js'
    );
    const steps = DEFAULT_PERIOD_CLOSE_STEPS.map((s, i) => ({
      ...s,
      status: i < 10 ? ('success' as const) : ('pending' as const),
    }));
    const session = await PeriodCloseSession.create({
      periodId: period._id,
      periodLabel: 'RMA-Gate Test Period',
      status: 'in_progress',
      steps,
      currentStepIndex: 10,
      startedAt: new Date(),
    });
    sessionId = String(session._id);
  });

  it('blocks close when an open RMA exists in the period', async () => {
    const rmasCol = mongoose.connection.db!.collection('rmas');
    const now = new Date();
    const inserted = await rmasCol.insertOne({
      rmaNumber: 'RMA-GATE-BLOCK-001',
      state: 'requested',
      organizationId: new mongoose.Types.ObjectId(env.orgId),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const { advanceSession } = await import(
      '../../../src/resources/accounting/period-close/period-close.service.js'
    );
    const updated = await advanceSession(sessionId);
    const step = updated.steps[10];
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/open RMA/i);

    await rmasCol.deleteOne({ _id: inserted.insertedId });
  });

  it('passes when no open RMAs remain in the period', async () => {
    const { advanceSession } = await import(
      '../../../src/resources/accounting/period-close/period-close.service.js'
    );
    const updated = await advanceSession(sessionId);
    const step = updated.steps[10];
    expect(step.status).toBe('success');
    expect((step.result as { openRmaCount?: number } | undefined)?.openRmaCount).toBe(0);
  });
});
