/**
 * Lean-virtual backfill regression — proves that customer list responses
 * (which flow through mongokit's `.lean(true)` path and would otherwise
 * strip Mongoose virtuals) carry `fullName` and `displayName` so SDK
 * consumers don't have to compose them client-side.
 *
 * The fix lives at `customer.model.ts:backfillCustomerVirtuals`, registered
 * as a post-`find` / post-`findOne` / post-`findOneAndUpdate` hook.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

let shouldDisconnect = false;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const memServer = await MongoMemoryServer.create();
    await mongoose.connect(memServer.getUri());
    shouldDisconnect = true;
  }
  ({ default: Customer } = await import('#resources/sales/customers/customer.model.js'));
}, 60_000);

afterAll(async () => {
  if (shouldDisconnect) await mongoose.disconnect();
});

beforeEach(async () => {
  await mongoose.connection.db?.collection('customers').deleteMany({});
});

describe('customer lean-virtual backfill', () => {
  it('lean find() emits fullName + displayName + revenueTier', async () => {
    await Customer.create({
      name: { given: 'Sadman', family: 'Hossain' },
      contact: { phone: '01700000001', email: 'sadman@example.com' },
      stats: { revenue: { lifetime: 25000 } },
    });

    const docs = await Customer.find({}).lean();
    expect(docs).toHaveLength(1);
    const doc = docs[0] as Record<string, unknown>;
    expect(doc.fullName).toBe('Sadman Hossain');
    expect(doc.displayName).toMatch(/Sadman/);
    expect(doc.revenueTier).toBe('silver');
  });

  it('lean findOne() also backfills', async () => {
    await Customer.create({
      name: { given: 'Solo', family: '' },
      contact: { phone: '01700000002' },
    });

    const doc = (await Customer.findOne({ 'contact.phone': '01700000002' }).lean()) as
      | Record<string, unknown>
      | null;
    expect(doc).not.toBeNull();
    expect(doc!.fullName).toBe('Solo');
    expect(doc!.revenueTier).toBe('bronze');
  });

  it('hydrated (non-lean) docs keep their virtual getters untouched', async () => {
    await Customer.create({
      name: { given: 'Ada', family: 'Lovelace' },
      contact: { phone: '01700000003' },
      stats: { revenue: { lifetime: 120000 } },
    });

    const doc = await Customer.findOne({ 'contact.phone': '01700000003' });
    expect(doc).not.toBeNull();
    // Mongoose Document — virtuals come from getters.
    expect(doc!.get('fullName')).toBe('Ada Lovelace');
    expect(doc!.get('revenueTier')).toBe('platinum');
  });

  it('skips backfill when name is missing (defensive)', async () => {
    // Bypass schema validation by inserting a partial doc directly so
    // we can assert the hook doesn't blow up on mid-migration data.
    await mongoose.connection.db?.collection('customers').insertOne({
      contact: { phone: '01700000004' },
      isActive: true,
    });

    const docs = await Customer.find({ 'contact.phone': '01700000004' }).lean();
    const doc = docs[0] as Record<string, unknown> | undefined;
    expect(doc).toBeTruthy();
    // No name → no fullName backfill (and no crash).
    expect(doc!.fullName).toBeUndefined();
    expect(doc!.revenueTier).toBe('bronze');
  });
});
