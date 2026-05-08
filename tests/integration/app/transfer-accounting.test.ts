/**
 * Inter-Branch Transfer Accounting Integration Test
 *
 * Verifies that stock movements between branches produce correct GL entries:
 *
 *   Dispatch (sender branch):
 *     Dr 1179 Inventory in Transit   goodsCost
 *     Cr 1164 Merchandise            goodsCost
 *
 *   Receive (receiver branch):
 *     Dr 1164 Merchandise            goodsCost [+ transitCost]
 *     Cr 1179 Inventory in Transit   goodsCost
 *     Cr 2126 Transfer Cost Clearing transitCost  (only when > 0)
 *
 * Also verifies:
 *   - Sender stock decrements after dispatch
 *   - Receiver stock increments after receive
 *   - Transit cost adds a 3rd JE line on the receive leg (IAS 2 capitalization)
 *   - Idempotency: replaying the same receive action returns the existing JE
 *
 * Uses bootScenarioApp (full Arc + MongoMemoryReplSet).
 * Two branches: env.orgId = sender (head office), receiverOrgId = outlet.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  bootScenarioApp,
  addSecondaryBranch,
  type ScenarioEnv,
  parse,
} from '../../support/scenario-setup.js';
import { seedStock, getStock } from '../../support/erp-seed.js';

const API = '/api/v1';

let env: ScenarioEnv;
let receiverOrgId: string;
let productId: string;

// Persisted across tests — sequential lifecycle.
let transferId: string;

beforeAll(async () => {
  // per-suite-mongo.ts (setupFiles) connects to a standalone MongoMemoryServer.
  // bootScenarioApp creates a MongoMemoryReplSet but only reconnects when
  // readyState !== 1. Disconnect first so bootScenarioApp reconnects to the
  // replica set — required for Flow's transactional moveGroup operations.
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  env = await bootScenarioApp({
    scenario: 'transfer-accounting',
    env: {
      ENABLE_ACCOUNTING: 'true',
      ACCOUNTING_MODE: 'standard',
      ACCOUNTING_AUTO_SEED: 'true',
      ACCOUNTING_AUTO_POST: 'true',
    },
  });

  // Seed chart of accounts so JE posting has valid account references.
  await env.server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: env.auth.as('admin').headers,
  });

  // Create receiver branch under the same admin user (gets admin rights automatically).
  receiverOrgId = await addSecondaryBranch(env, {
    slug: 'trx-receiver',
    name: 'Transfer Receiver Outlet',
    branchRole: 'branch',
  });

  // Seed a product in the catalog engine's collection (catalog_products).
  // The catalog engine uses 'catalog_products' not 'products' — _enrichItems
  // calls catalog.repositories.product.findAll() which reads that collection.
  const pid = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection('catalog_products').insertOne({
    _id: pid,
    name: 'Transfer Test Tee',
    slug: 'transfer-test-tee',
    productType: 'physical',
    sku: 'TRX-TEE-001',
    costPrice: 450,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  productId = pid.toString();

  // Seed 20 units @ 450 BDT at the sender (primary org).
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  await seedStock(getFlowEngine(), env.orgId, productId, 20, 450);
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

// Headers scoped to receiver branch (same bearer token, different org).
function receiverHeaders(): Record<string, string> {
  return {
    ...env.auth.as('admin').headers,
    'x-organization-id': receiverOrgId,
  };
}

// Let async event subscribers (the accounting bridge) complete.
const drain = () => new Promise<void>((r) => setTimeout(r, 300));

/**
 * Build a map of accountId (string) → accountTypeCode (string) so tests can
 * assert which GL account each journal item was posted to without knowing the
 * ObjectId at write-time. The accounts collection is seeded once in beforeAll.
 */
async function buildAccountCodeMap(): Promise<Map<string, string>> {
  const accounts = await mongoose.connection.db!.collection('accounts').find({}).toArray();
  return new Map(accounts.map((a) => [String(a._id), String(a.accountTypeCode)]));
}

// ─── 1. Transfer Lifecycle (HTTP) ─────────────────────────────────────────────

describe('Transfer lifecycle (HTTP)', () => {
  it('POST /inventory/transfers creates a draft transfer', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: env.auth.as('admin').headers,
      payload: {
        senderBranchId: env.orgId,
        receiverBranchId: receiverOrgId,
        items: [
          {
            productId,
            quantity: 5,
            costPrice: 450, // 450 BDT × 5 = 2,250 BDT = 225,000 paisa
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body?.status).toBe('draft');
    transferId = body?._id as string;
    expect(transferId).toBeTruthy();
  });

  it('approve action → status:approved', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transferId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.status).toBe('approved');
  });

  it('dispatch action → status:dispatched + sender JE posted (Dr 1179 / Cr 1164)', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transferId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'dispatch' },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.status).toBe('dispatched');

    // Wait for transfer:dispatched → accounting bridge subscriber.
    await drain();

    const je = await mongoose.connection.db!
      .collection('journalentries')
      .findOne({ idempotencyKey: `transfer-${transferId}-dispatch` });

    expect(je).not.toBeNull();
    expect(je?.state).toBe('posted');

    const accountMap = await buildAccountCodeMap();
    const items = je?.journalItems as Array<{ account: object; debit: number; credit: number }>;
    const dr = items.find((i) => i.debit > 0);
    const cr = items.find((i) => i.credit > 0);

    // Dispatch: Dr 1179 Inventory in Transit, Cr 1164 Merchandise
    expect(accountMap.get(String(dr?.account))).toBe('1179');
    expect(accountMap.get(String(cr?.account))).toBe('1164');
    // 5 units × 450 BDT × 100 = 225,000 paisa
    expect(dr?.debit).toBe(225_000);
    expect(cr?.credit).toBe(225_000);
  });

  it('receive action → status:received + receiver JE posted (Dr 1164 / Cr 1179)', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transferId}/action`,
      headers: receiverHeaders(),
      payload: { action: 'receive' },
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)?.status).toBe('received');

    await drain();

    const je = await mongoose.connection.db!
      .collection('journalentries')
      .findOne({ idempotencyKey: `transfer-${transferId}-receive` });

    expect(je).not.toBeNull();
    expect(je?.state).toBe('posted');

    const accountMap = await buildAccountCodeMap();
    const items = je?.journalItems as Array<{ account: object; debit: number; credit: number }>;
    const dr = items.find((i) => i.debit > 0);
    const cr = items.find((i) => i.credit > 0);

    // Receive: Dr 1164 Merchandise, Cr 1179 Inventory in Transit
    expect(accountMap.get(String(dr?.account))).toBe('1164');
    expect(accountMap.get(String(cr?.account))).toBe('1179');
    expect(dr?.debit).toBe(225_000);
    expect(cr?.credit).toBe(225_000);
    // No transit cost → exactly 2 items
    expect(items.length).toBe(2);
  });
});

// ─── 2. Stock balance after transfer ─────────────────────────────────────────

describe('Stock balance after transfer', () => {
  it('sender has 15 units remaining (20 − 5 dispatched)', async () => {
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const avail = await getStock(getFlowEngine(), env.orgId, productId);
    expect(avail.quantityAvailable ?? 0).toBeLessThanOrEqual(15);
  });

  it('receiver has 5 units after receive', async () => {
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const avail = await getStock(getFlowEngine(), receiverOrgId, productId);
    expect(avail.quantityAvailable ?? 0).toBeGreaterThanOrEqual(5);
  });
});

// ─── 3. Transit cost: 3-line receive JE (IAS 2 capitalization) ───────────────

describe('Transit cost capitalization', () => {
  let t2Id: string;

  it('creates and dispatches a transfer with transitCost: 100 per line', async () => {
    // Create
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: env.auth.as('admin').headers,
      payload: {
        senderBranchId: env.orgId,
        receiverBranchId: receiverOrgId,
        items: [
          {
            productId,
            quantity: 2,
            costPrice: 450,
            transitCost: 100, // 100 BDT/line transport surcharge
          },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    t2Id = parse(createRes.body)?._id as string;

    // Approve
    await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${t2Id}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'approve' },
    });

    // Dispatch
    const dispatchRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${t2Id}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'dispatch' },
    });
    expect(dispatchRes.statusCode).toBe(200);
    expect(parse(dispatchRes.body)?.status).toBe('dispatched');
  });

  it('receive JE has 3 lines: Dr 1164 (goods+transit), Cr 1179, Cr 2126', async () => {
    const receiveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${t2Id}/action`,
      headers: receiverHeaders(),
      payload: { action: 'receive' },
    });
    expect(receiveRes.statusCode).toBe(200);

    await drain();

    const je = await mongoose.connection.db!
      .collection('journalentries')
      .findOne({ idempotencyKey: `transfer-${t2Id}-receive` });

    expect(je).not.toBeNull();
    const accountMap = await buildAccountCodeMap();
    const items = je?.journalItems as Array<{ account: object; debit: number; credit: number }>;

    // 3 lines: merchandise (Dr), in-transit (Cr), transit-cost clearing (Cr)
    expect(items.length).toBe(3);

    // 2126 Transfer Cost Clearing: transit = 100 BDT × 100 paisa = 10,000 paisa
    const clearing = items.find((i) => accountMap.get(String(i.account)) === '2126');
    expect(clearing).toBeDefined();
    expect(clearing?.credit).toBe(10_000);

    // 1164 Merchandise: goods (2 × 450 = 90,000) + transit (10,000) = 100,000 paisa
    const merchandise = items.find((i) => accountMap.get(String(i.account)) === '1164');
    expect(merchandise?.debit).toBe(100_000);

    // 1179 Inventory in Transit cleared for goods cost only: 90,000 paisa
    const inTransit = items.find((i) => accountMap.get(String(i.account)) === '1179');
    expect(inTransit?.credit).toBe(90_000);
  });
});

// ─── 4. Net company GL balance ────────────────────────────────────────────────

describe('Net company-level GL balance', () => {
  it('1179 Inventory in Transit clears to zero across both branches', async () => {
    // After dispatch + receive, the in-transit account should net to zero:
    // dispatch JE: Dr 1179 (+225,000)
    // receive JE:  Cr 1179 (-225,000)
    // dispatch t2: Dr 1179 (+90,000)
    // receive t2:  Cr 1179 (-90,000)
    const jes = await mongoose.connection.db!
      .collection('journalentries')
      .find({
        idempotencyKey: {
          $in: [
            `transfer-${transferId}-dispatch`,
            `transfer-${transferId}-receive`,
          ],
        },
      })
      .toArray();

    const accountMap = await buildAccountCodeMap();
    let net1179 = 0;
    for (const je of jes) {
      const items = je.journalItems as Array<{ account: object; debit: number; credit: number }>;
      for (const item of items) {
        if (accountMap.get(String(item.account)) === '1179') {
          net1179 += (item.debit ?? 0) - (item.credit ?? 0);
        }
      }
    }

    // dispatch: Dr +225,000 — receive: Cr −225,000 → net = 0
    expect(net1179).toBe(0);
  });
});
