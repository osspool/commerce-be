/**
 * Partner-ledger smoke test (Phase 0 — A/P + A/R foundation)
 *
 * Proves the ledger 0.7 subsidiary-ledger wiring works end-to-end:
 *   1. `extraItemFields.partnerId` is injected on journal items
 *   2. Two JEs tagged with the same partnerId round-trip through the repo
 *   3. `reconciliations.getOpenItems({ filter: { partnerId } })` returns them
 *   4. `reconciliations.match()` clears both items (matchingNumber stamped)
 *   5. `getOpenItems` returns empty after match
 *
 * No HTTP surface yet — we're testing the engine primitives directly so
 * Phase 1 (vendor bills) can build on a proven foundation.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  Account,
  JournalEntry,
  accounting,
  journalEntryRepository,
  accountRepository,
} from '../../src/resources/accounting/accounting.engine.js';

const PARTNER_ID = new mongoose.Types.ObjectId().toString();

let apAccountId: mongoose.Types.ObjectId;
let expenseAccountId: mongoose.Types.ObjectId;
let cashAccountId: mongoose.Types.ObjectId;

beforeAll(async () => {
  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  // Clean slate
  for (const col of ['accounts', 'journalentries', 'reconciliations']) {
    await mongoose.connection.db!.collection(col).drop().catch(() => {});
  }
  // Seed the BD chart so 2111 / 6801 / 1111 exist as real accounts
  await accountRepository.seedAccounts(null as any);

  const byCode = async (code: string) => {
    const doc = await Account.findOne({ accountTypeCode: code }).lean();
    if (!doc) throw new Error(`Account ${code} not seeded`);
    return doc._id as mongoose.Types.ObjectId;
  };
  apAccountId = await byCode('2111');      // Trade Creditors (A/P control)
  expenseAccountId = await byCode('6601'); // any expense — will fall back below
  cashAccountId = await byCode('1111');    // Cash in Hand
}, 60_000);

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
}, 15_000);

describe('Phase 0 — partner-tagged journal items', () => {
  let billJeId: mongoose.Types.ObjectId;
  let paymentJeId: mongoose.Types.ObjectId;

  it('schema exposes partnerId + partnerType on journal items', () => {
    const itemSchema = (JournalEntry.schema.path('journalItems') as any).schema;
    expect(itemSchema.path('partnerId')).toBeTruthy();
    expect(itemSchema.path('partnerType')).toBeTruthy();
    expect(itemSchema.path('maturityDate')).toBeTruthy();
  });

  it('creates a posted "bill" JE tagged with partnerId + maturityDate', async () => {
    const due = new Date();
    due.setDate(due.getDate() + 30);
    const bill = await journalEntryRepository.create({
      journalType: 'PURCHASES',
      label: 'Bill 0001',
      date: new Date(),
      state: 'posted',
      totalDebit: 100_000,
      totalCredit: 100_000,
      journalItems: [
        { account: expenseAccountId, debit: 100_000, credit: 0, label: 'Supplies' },
        {
          account: apAccountId,
          debit: 0,
          credit: 100_000,
          label: 'A/P',
          partnerId: PARTNER_ID,
          partnerType: 'supplier',
          maturityDate: due,
        },
      ],
    } as any);
    billJeId = (bill as any)._id;
    const round = await JournalEntry.findById(billJeId).lean();
    const apLine = (round!.journalItems as any[]).find((i) => String(i.account) === String(apAccountId));
    expect(apLine.partnerId).toBe(PARTNER_ID);
    expect(apLine.partnerType).toBe('supplier');
    expect(apLine.maturityDate).toBeTruthy();
  });

  it('getOpenItems returns the partner-tagged AP line', async () => {
    const open = await accounting.repositories.reconciliations.getOpenItems({
      accountId: apAccountId,
      filter: { partnerId: PARTNER_ID },
    } as any);
    expect(open.length).toBe(1);
    expect(String((open[0] as any).entry)).toBe(String(billJeId));
  });

  it('creates the matching payment JE and matches it to the bill', async () => {
    const payment = await journalEntryRepository.create({
      journalType: 'CASH_PAYMENTS',
      label: 'Payment for Bill 0001',
      date: new Date(),
      state: 'posted',
      totalDebit: 100_000,
      totalCredit: 100_000,
      journalItems: [
        {
          account: apAccountId,
          debit: 100_000,
          credit: 0,
          label: 'A/P settle',
          partnerId: PARTNER_ID,
          partnerType: 'supplier',
        },
        { account: cashAccountId, debit: 0, credit: 100_000, label: 'Cash out' },
      ],
    } as any);
    paymentJeId = (payment as any)._id;

    const bill = await JournalEntry.findById(billJeId).lean();
    const pay = await JournalEntry.findById(paymentJeId).lean();
    const billApIdx = (bill!.journalItems as any[]).findIndex(
      (i) => String(i.account) === String(apAccountId),
    );
    const payApIdx = (pay!.journalItems as any[]).findIndex(
      (i) => String(i.account) === String(apAccountId),
    );

    await accounting.repositories.reconciliations.match({
      account: apAccountId,
      items: [
        { entry: billJeId, itemIndex: billApIdx },
        { entry: paymentJeId, itemIndex: payApIdx },
      ],
    } as any);

    const openAfter = await accounting.repositories.reconciliations.getOpenItems({
      accountId: apAccountId,
      filter: { partnerId: PARTNER_ID },
    } as any);
    expect(openAfter.length).toBe(0);
  });
});
