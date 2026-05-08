/**
 * Contract test — `GET /accounting/journal-entries/by-source`
 *
 * The endpoint backs the FE's reusable `JournalEntryAuditTrail` component
 * (used on Transfer + Procurement detail pages). It must:
 *
 *   - Validate `sourceModel` and `sourceId` (querystring schema)
 *   - Filter to the active branch via `orgScoped`
 *   - Return entries sorted oldest first so reversal pairs read in order
 *   - Pair original + reversal entries — when both exist, both come back
 *
 * The reversal-pairing visualization happens in the FE component; backend
 * just ensures both rows are present in the result so the FE can pair.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;

const ADMIN = { id: 'jbs-admin', _id: 'jbs-admin', role: ['admin', 'finance_admin'] };
const ORG = new mongoose.Types.ObjectId().toString();
const OTHER_ORG = new mongoose.Types.ObjectId().toString();
const API = '/api/v1/accounting/journal-entries/by-source';

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.COOKIE_SECRET = 'c'.repeat(40);
  process.env.BETTER_AUTH_SECRET = 'd'.repeat(40);
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const journalEntry = (
    await import('../../../src/resources/accounting/journal-entry/journal-entry.resource.js')
  ).default;

  app = Fastify({ logger: false });
  // biome-ignore lint/suspicious/noExplicitAny: stub
  app.addHook('onRequest', async (req: any) => {
    req.user = ADMIN;
    // `kind: 'member'` is what `requireOrgMembership` checks via `hasOrgAccess`.
    req.scope = {
      kind: 'member',
      organizationId: ORG,
      userId: ADMIN.id,
      orgRoles: ['admin', 'finance_admin'],
    };
  });
  await app.register(
    async (s) => {
      await s.register(journalEntry.toPlugin());
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

async function seedJE(input: {
  orgId: string;
  sourceModel: string;
  sourceId: string;
  date: Date;
  state?: string;
  reversed?: boolean;
  reversedBy?: string;
  reversalOf?: string;
  totalDebit?: number;
  label?: string;
}): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('journalentries').insertOne({
    _id,
    organizationId: new mongoose.Types.ObjectId(input.orgId),
    sourceRef: { sourceModel: input.sourceModel, sourceId: input.sourceId },
    date: input.date,
    state: input.state ?? 'posted',
    journalType: 'INVENTORY',
    journalItems: [],
    totalDebit: input.totalDebit ?? 1000,
    totalCredit: input.totalDebit ?? 1000,
    label: input.label ?? 'JE',
    reversed: input.reversed ?? false,
    ...(input.reversedBy ? { reversedBy: new mongoose.Types.ObjectId(input.reversedBy) } : {}),
    ...(input.reversalOf ? { reversalOf: new mongoose.Types.ObjectId(input.reversalOf) } : {}),
    createdAt: input.date,
    updatedAt: input.date,
  });
  return String(_id);
}

async function clearJEs(): Promise<void> {
  await mongoose.connection.collection('journalentries').deleteMany({});
}

describe('GET /accounting/journal-entries/by-source', () => {
  it('returns 400 when sourceModel is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceId=tx-1`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when sourceId is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceModel=Transfer`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty array for unknown source', async () => {
    await clearJEs();
    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceModel=Transfer&sourceId=does-not-exist`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body).toEqual([]);
  });

  it('returns matching entries sorted oldest first', async () => {
    await clearJEs();
    await seedJE({
      orgId: ORG,
      sourceModel: 'Transfer',
      sourceId: 'tr-A',
      date: new Date('2024-03-15'),
      label: 'second',
    });
    await seedJE({
      orgId: ORG,
      sourceModel: 'Transfer',
      sourceId: 'tr-A',
      date: new Date('2024-02-01'),
      label: 'first',
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceModel=Transfer&sourceId=tr-A`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(2);
    expect(data[0].label).toBe('first');
    expect(data[1].label).toBe('second');
  });

  it('returns the original + reversal pair so the FE can render them together', async () => {
    await clearJEs();
    const originalId = await seedJE({
      orgId: ORG,
      sourceModel: 'Transfer',
      sourceId: 'tr-pair',
      date: new Date('2024-04-01'),
      label: 'original',
      reversed: true,
    });
    const reversalId = await seedJE({
      orgId: ORG,
      sourceModel: 'Transfer',
      sourceId: 'tr-pair',
      date: new Date('2024-04-05'),
      label: 'reversal',
      reversalOf: originalId,
    });
    // Update the original to point at the reversal — the ledger's reverse
    // verb does this in real flows; we simulate it with a Mongo update.
    await mongoose.connection.collection('journalentries').updateOne(
      { _id: new mongoose.Types.ObjectId(originalId) },
      { $set: { reversedBy: new mongoose.Types.ObjectId(reversalId) } },
    );

    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceModel=Transfer&sourceId=tr-pair`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(2);
    const original = data.find((d: { label: string }) => d.label === 'original');
    const reversal = data.find((d: { label: string }) => d.label === 'reversal');
    expect(original?.reversed).toBe(true);
    expect(String(original?.reversedBy)).toBe(reversalId);
    expect(String(reversal?.reversalOf)).toBe(originalId);
  });

  it('does not leak entries from a different branch', async () => {
    await clearJEs();
    // Two JEs for the same source, but stamped on different branches.
    await seedJE({
      orgId: ORG,
      sourceModel: 'PurchaseOrder',
      sourceId: 'po-cross',
      date: new Date('2024-05-01'),
      label: 'mine',
    });
    await seedJE({
      orgId: OTHER_ORG,
      sourceModel: 'PurchaseOrder',
      sourceId: 'po-cross',
      date: new Date('2024-05-02'),
      label: 'someone-else',
    });

    const res = await app.inject({
      method: 'GET',
      url: `${API}?sourceModel=PurchaseOrder&sourceId=po-cross`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].label).toBe('mine');
  });
});
