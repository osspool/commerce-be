/**
 * CRM HTTP e2e — full lead-to-customer story through the REST API.
 *
 * Uses `bootScenarioApp` (which sets up MongoMemoryReplSet + Arc app +
 * Better Auth org) so requests flow through the full pipeline: auth,
 * permissions, body validation, audit, hooks, resource controller,
 * adapter, mongokit. No direct repo writes after seed.
 *
 * The story:
 *   1. Admin seeds a sales Pipeline with two stages (Qualified, Won).
 *   2. A lead is created (POST /crm/leads) and qualified
 *      (POST /crm/leads/:id/action { action: "qualify" }).
 *   3. The lead is converted — spawns Contact (a customer row with
 *      crm.stage = 'lead'), Account (crm_accounts), and Opportunity.
 *   4. The crm:lead.converted bridge flips the customer to "prospect".
 *   5. The opportunity is advanced to the Won stage, then the win
 *      action transitions status to won.
 *   6. The crm:opportunity.won bridge flips the customer to "active"
 *      via the `primaryContactId` lookup path.
 *   7. Terminal transitions are rejected; auth guards still work.
 */

import type { FastifyInstance } from 'fastify';
import type { AuthProvider, TestOrgContext } from '@classytic/arc/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';

const API = '/api/v1';
const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b) as Record<string, unknown>;
  } catch {
    return null;
  }
};

let envA: ScenarioEnv;
let server: FastifyInstance;
let auth: AuthProvider;
let otherCtx: TestOrgContext;
let otherAuth: AuthProvider;

const h = (): Record<string, string> => auth.getHeaders('admin');
const h2 = (): Record<string, string> => otherAuth.getHeaders('admin');

let pipelineId: string;
let qualifiedStageId: string;
let wonStageId: string;
let leadId: string;
let contactCustomerId: string;
let accountId: string;
let opportunityId: string;

beforeAll(async () => {
  envA = await bootScenarioApp({
    scenario: 'crm-http',
    env: { CRM_MODE: 'simple' },
  });
  server = envA.server;
  auth = envA.auth;

  // Second org on the same server — proves cross-branch isolation for the
  // per-branch CRM collections (crm_pipelines / crm_opportunities / …).
  const { setupBetterAuthOrg, createBetterAuthProvider } = await import('@classytic/arc/testing');
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const ts = Date.now();
  otherCtx = await setupBetterAuthOrg({
    createApp: () => Promise.resolve(server),
    org: { name: `CrmB-${ts}`, slug: `crm-b-${ts}` },
    users: [
      {
        key: 'admin',
        email: `crm-admin-b-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'CRM Admin B',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });
  await mongoose.connection.db!
    .collection('user')
    .updateOne({ email: otherCtx.users.admin.email }, { $set: { role: ['admin'] } });
  const login = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: otherCtx.users.admin.email, password: 'TestPass123!' },
  });
  const token = (parse(login.body)?.token as string | undefined) ?? otherCtx.users.admin.token;
  otherAuth = createBetterAuthProvider({
    tokens: { admin: token },
    orgId: otherCtx.orgId,
    adminRole: 'admin',
  });
}, 120_000);

afterAll(async () => {
  if (envA) await envA.teardown();
}, 30_000);

describe('CRM HTTP e2e — lead → converted → won via Arc actions', () => {
  it('seeds a sales pipeline with two stages', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/pipelines`,
      headers: h(),
      payload: {
        name: 'New Business',
        isArchived: false,
        stages: [
          { id: 'qualified', name: 'Qualified', sequence: 1, defaultProbability: 0.3 },
          { id: 'won', name: 'Won', sequence: 2, defaultProbability: 0.9 },
        ],
      },
    });
    if (res.statusCode >= 300) console.log('pipeline fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    const data = body?.data as { _id: string; stages: Array<{ id: string }> };
    pipelineId = data._id;
    qualifiedStageId = data.stages[0]!.id;
    wonStageId = data.stages[1]!.id;
    expect(pipelineId).toBeTruthy();
    expect(qualifiedStageId).toBe('qualified');
  });

  it('creates a lead via POST /crm/leads', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/leads`,
      headers: h(),
      payload: {
        firstName: 'Grace',
        lastName: 'Hopper',
        fullName: 'Grace Hopper',
        email: 'grace@navy.example.com',
        phone: '+8801700000010',
        companyName: 'Navy Ordnance',
        jobTitle: 'Rear Admiral',
        source: 'referral',
      },
    });
    if (res.statusCode >= 300) console.log('lead create fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);
    const body = parse(res.body);
    const data = body?.data as { _id: string; status: string };
    leadId = data._id;
    expect(data.status).toBe('new');
  });

  it('qualifies the lead via POST /crm/leads/:id/action', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/leads/${leadId}/action`,
      headers: h(),
      payload: { action: 'qualify', note: 'BANT check passed' },
    });
    if (res.statusCode >= 300) console.log('qualify fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);

    const getRes = await server.inject({
      method: 'GET',
      url: `${API}/crm/leads/${leadId}`,
      headers: h(),
    });
    const body = parse(getRes.body);
    expect((body?.data as { status: string }).status).toBe('qualified');
  });

  it('converts the lead — spawns Contact + Account + Opportunity', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/leads/${leadId}/action`,
      headers: h(),
      payload: {
        action: 'convert',
        pipelineId,
        amount: { amount: 250_000, currency: 'BDT' },
      },
    });
    if (res.statusCode >= 300) console.log('convert fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);
    const body = parse(res.body);
    const data = body?.data as {
      contactId: string;
      accountId: string;
      opportunityId: string;
      lead: { status: string };
    };
    contactCustomerId = data.contactId;
    accountId = data.accountId;
    opportunityId = data.opportunityId;
    expect(data.lead.status).toBe('converted');
    expect(contactCustomerId).toBeTruthy();
    expect(accountId).toBeTruthy();
    expect(opportunityId).toBeTruthy();

    // Contact = Customer row with structured name + crm.stage='lead' initially.
    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    const customer = await Customer.findById(contactCustomerId).lean();
    expect(customer?.name.given).toBe('Grace');
    expect(customer?.contact.phone).toBe('+8801700000010');
  });

  it('lead.converted bridge flipped the customer to "prospect"', async () => {
    // Event bridges fire after the HTTP response — let the in-process
    // transport settle.
    await new Promise((r) => setTimeout(r, 50));

    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    const customer = (await Customer.findById(contactCustomerId).lean()) as {
      crm?: { stage?: string; convertedFromLeadId?: string };
    } | null;
    expect(customer?.crm?.stage).toBe('prospect');
    expect(customer?.crm?.convertedFromLeadId).toBe(leadId);
  });

  it('advances the opportunity to the "won" stage via Arc action', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/opportunities/${opportunityId}/action`,
      headers: h(),
      payload: { action: 'advanceToStage', stageId: wonStageId },
    });
    if (res.statusCode >= 300) console.log('advance fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);

    const getRes = await server.inject({
      method: 'GET',
      url: `${API}/crm/opportunities/${opportunityId}`,
      headers: h(),
    });
    const data = parse(getRes.body)?.data as { stageId: string; status: string };
    expect(data.stageId).toBe(wonStageId);
    expect(data.status).toBe('open');
  });

  it('wins the opportunity — status becomes "won", customer stage flips to "active"', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/opportunities/${opportunityId}/action`,
      headers: h(),
      payload: { action: 'win' },
    });
    if (res.statusCode >= 300) console.log('win fail:', res.statusCode, res.body);
    expect(res.statusCode).toBeLessThan(300);
    const data = parse(res.body)?.data as { status: string; probability: number };
    expect(data.status).toBe('won');
    expect(data.probability).toBe(1);

    // Bridge runs asynchronously; give the opportunity lookup a chance.
    await new Promise((r) => setTimeout(r, 80));

    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    const customer = (await Customer.findById(contactCustomerId).lean()) as {
      crm?: { stage?: string; lastContactedAt?: Date };
    } | null;
    expect(customer?.crm?.stage).toBe('active');
    expect(customer?.crm?.lastContactedAt).toBeTruthy();
  });

  it('rejects a second convert() — converted is a terminal status', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/crm/leads/${leadId}/action`,
      headers: h(),
      payload: { action: 'convert', pipelineId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('cross-branch GET /crm/pipelines does not leak the owning branch pipeline', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/crm/pipelines`,
      headers: h2(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const items = ((body?.data ?? body?.items ?? []) as Array<{ _id: string }>) ?? [];
    expect(items.find((p) => p._id === pipelineId)).toBeUndefined();
  });

  it('cross-branch GET /crm/opportunities/:id returns 404 (branch scoping on findById)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/crm/opportunities/${opportunityId}`,
      headers: h2(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated requests to CRM endpoints get 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/crm/leads`,
    });
    expect(res.statusCode).toBe(401);
  });
});
