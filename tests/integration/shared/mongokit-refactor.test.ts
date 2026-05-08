/**
 * Pins the mongokit refactor (2026-05) — every callsite that previously
 * reached into `<repo>.Model.*` now goes through repository verbs. These
 * tests boot mongo-memory, exercise each refactored entry point at the
 * repository level, and assert the doc round-trips cleanly.
 *
 * Each block targets one file from the audit:
 *
 *   - branch.repository.ts      → getDefaultBranch / getHeadOffice / isHeadOffice
 *                                  / getSubBranches / getActiveBranches
 *   - cms.controller upserts    → CMSRepository.findOneAndUpdate (upsert path)
 *   - settlement-import.repo    → findUnmatchedLegs / findOpenStatements
 *
 * The musok / sales-overview / period-close / settlement-service refactors
 * already have higher-level tests (period-close-repository.test.ts +
 * scenarios). This file fills the remaining gaps.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let branchRepository: typeof import('../../../src/resources/commerce/branch/branch.repository.js')['default'];
let CMSRepository: typeof import('../../../src/resources/content/cms/cms.repository.js')['default'];
let settlementImportRepository: typeof import('../../../src/resources/accounting/settlement/settlement-import.repository.js')['default'];

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.COOKIE_SECRET = 'c'.repeat(40);
  process.env.BETTER_AUTH_SECRET = 'd'.repeat(40);
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  ({ default: branchRepository } = await import(
    '../../../src/resources/commerce/branch/branch.repository.js'
  ));
  ({ default: CMSRepository } = await import(
    '../../../src/resources/content/cms/cms.repository.js'
  ));
  ({ default: settlementImportRepository } = await import(
    '../../../src/resources/accounting/settlement/settlement-import.repository.js'
  ));
}, 120_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

describe('mongokit refactor — branch.repository', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('organization').deleteMany({});
  });

  it('getDefaultBranch creates one when none exists, then returns it on subsequent calls', async () => {
    const first = await branchRepository.getDefaultBranch();
    expect(first).toBeTruthy();
    expect(first.isDefault).toBe(true);
    expect(first.isActive).toBe(true);

    const second = await branchRepository.getDefaultBranch();
    expect(String(second._id)).toBe(String(first._id));
  });

  it('getDefaultBranch promotes the only active branch when no default is set', async () => {
    // Seed an active branch without isDefault — the repo should flip it.
    await branchRepository.create({
      code: 'STORE-A',
      name: 'Store A',
      slug: 'store-a',
      branchType: 'store',
      branchRole: 'sub_branch',
      isActive: true,
      isDefault: false,
    });

    const def = await branchRepository.getDefaultBranch();
    expect(def.code).toBe('STORE-A');
    expect(def.isDefault).toBe(true);
  });

  it('isHeadOffice reads via getById without dropping into Model.findById', async () => {
    const ho = await branchRepository.create({
      code: 'HO-T',
      name: 'Head Office Test',
      slug: 'ho-t',
      branchType: 'warehouse',
      branchRole: 'head_office',
      isActive: true,
      isDefault: true,
    });

    expect(await branchRepository.isHeadOffice(String(ho._id))).toBe(true);

    const sub = await branchRepository.create({
      code: 'SUB-T',
      name: 'Sub T',
      slug: 'sub-t',
      branchType: 'store',
      branchRole: 'sub_branch',
      isActive: true,
    });
    expect(await branchRepository.isHeadOffice(String(sub._id))).toBe(false);
    expect(await branchRepository.isHeadOffice(new mongoose.Types.ObjectId().toString())).toBe(false);
  });

  it('isHeadOffice falls back to legacy `role` field when `branchRole` is unset', async () => {
    // Older docs in the wild may carry only `role`. We promised to read either.
    await mongoose.connection.collection('organization').insertOne({
      code: 'LEGACY-HO',
      name: 'Legacy HO',
      slug: 'legacy-ho',
      branchType: 'warehouse',
      role: 'head_office',
      isActive: true,
    } as Record<string, unknown>);
    const doc = await mongoose.connection.collection('organization').findOne({ code: 'LEGACY-HO' });
    expect(await branchRepository.isHeadOffice(String(doc!._id))).toBe(true);
  });

  it('getSubBranches returns only branches whose role is NOT head_office', async () => {
    await branchRepository.create({
      code: 'HO-S',
      name: 'HO',
      slug: 'ho-s',
      branchType: 'warehouse',
      branchRole: 'head_office',
      isActive: true,
      isDefault: true,
    });
    await branchRepository.create({
      code: 'SUB-1',
      name: 'Sub 1',
      slug: 'sub-1',
      branchType: 'store',
      branchRole: 'sub_branch',
      isActive: true,
    });
    await branchRepository.create({
      code: 'SUB-2',
      name: 'Sub 2',
      slug: 'sub-2',
      branchType: 'store',
      branchRole: 'sub_branch',
      isActive: true,
    });
    const subs = await branchRepository.getSubBranches();
    expect(subs.map((b) => b.code).sort()).toEqual(['SUB-1', 'SUB-2']);
  });

  it('getActiveBranches returns active branches with default first', async () => {
    await branchRepository.create({
      code: 'Z-LATE',
      name: 'Z Late',
      slug: 'z-late',
      branchType: 'store',
      isActive: true,
      isDefault: false,
    });
    await branchRepository.create({
      code: 'A-DEF',
      name: 'A Default',
      slug: 'a-def',
      branchType: 'store',
      isActive: true,
      isDefault: true,
    });
    await branchRepository.create({
      code: 'B-NORM',
      name: 'B Normal',
      slug: 'b-norm',
      branchType: 'store',
      isActive: true,
      isDefault: false,
    });
    // Seed an inactive branch to confirm filtering.
    await branchRepository.create({
      code: 'INACTIVE',
      name: 'Inactive',
      slug: 'inactive',
      branchType: 'store',
      isActive: false,
    });

    const list = await branchRepository.getActiveBranches();
    expect(list.map((b) => b.code).sort()).toEqual(['A-DEF', 'B-NORM', 'Z-LATE']);
    expect(list[0]?.code).toBe('A-DEF'); // default-first invariant
  });

  it('getHeadOffice promotes default branch when no head_office exists', async () => {
    // Seed a default branch without a head_office role.
    const def = await branchRepository.create({
      code: 'NEW-DEF',
      name: 'New Default',
      slug: 'new-def',
      branchType: 'store',
      isActive: true,
      isDefault: true,
    });

    const ho = await branchRepository.getHeadOffice();
    expect(ho).toBeTruthy();
    expect(String(ho?._id)).toBe(String(def._id));
    // After promotion the persisted doc should also reflect the role.
    const reloaded = await branchRepository.getById(String(def._id));
    expect((reloaded as { branchRole?: string })?.branchRole).toBe('head_office');
  });
});

describe('mongokit refactor — CMSRepository upsert path', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('cms').deleteMany({});
  });

  it('findOneAndUpdate(upsert: true) creates a missing CMS page', async () => {
    const page = await CMSRepository.findOneAndUpdate(
      { slug: 'home' },
      { $set: { slug: 'home', name: 'home', content: { hero: { headline: 'hi' } } } },
      { upsert: true, runValidators: true },
    );
    expect(page).toBeTruthy();
    expect(page?.slug).toBe('home');
    expect((page?.content as { hero?: { headline?: string } })?.hero?.headline).toBe('hi');
  });

  it('findOneAndUpdate(upsert: true) updates an existing CMS page in place', async () => {
    await CMSRepository.create({ slug: 'about', name: 'about', content: { v: 1 } });
    const updated = await CMSRepository.findOneAndUpdate(
      { slug: 'about' },
      { $set: { content: { v: 2 } } },
      { upsert: true, runValidators: true },
    );
    expect((updated?.content as { v?: number })?.v).toBe(2);
    const count = await CMSRepository.count({ slug: 'about' });
    expect(count).toBe(1); // not duplicated
  });

  it('delete(_id) removes the page (replaces the legacy Model.findOneAndDelete)', async () => {
    const page = await CMSRepository.create({ slug: 'gone', name: 'gone', content: {} });
    await CMSRepository.delete(String(page._id));
    const after = await CMSRepository.getByQuery({ slug: 'gone' }, { throwOnNotFound: false });
    expect(after).toBeNull();
  });
});

describe('mongokit refactor — settlement-import.repository read paths', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('settlement_imports').deleteMany({});
  });

  async function seed(overrides: Record<string, unknown> = {}) {
    const orgId = new mongoose.Types.ObjectId();
    return settlementImportRepository.create({
      organizationId: orgId,
      provider: 'stripe',
      clearingAccountCode: '1125',
      bankAccountCode: '1113',
      feeAccountCode: '6420',
      writeoffAccountCode: '6499',
      externalRef: 'sttl-001',
      statementDate: new Date(),
      totalGross: 1000,
      totalFee: 30,
      totalWriteoff: 0,
      totalNet: 970,
      status: 'pending',
      legs: [
        {
          externalTxnRef: 'L1',
          gross: 1000,
          fee: 30,
          writeoff: 0,
          net: 970,
          txnDate: new Date(),
          settlementDate: new Date(),
          matchState: 'unmatched',
        },
      ],
      ...overrides,
    } as Record<string, unknown>);
  }

  it('findUnmatchedLegs returns unmatched legs for the given org (no Model.find leak)', async () => {
    const doc = await seed();
    const legs = await settlementImportRepository.findUnmatchedLegs(String(doc.organizationId));
    expect(legs.length).toBe(1);
    expect(legs[0]?.matchState).toBe('unmatched');
    expect(String(legs[0]?.importId)).toBe(String(doc._id));
  });

  it('findOpenStatements buckets pending+posted statements as of the cutoff', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await seed({ organizationId: orgId });
    await seed({
      organizationId: orgId,
      status: 'posted',
      externalRef: 'sttl-002',
      statementDate: new Date('2026-01-01'),
    });
    await seed({
      organizationId: orgId,
      status: 'cancelled',
      externalRef: 'sttl-003',
    });

    const open = await settlementImportRepository.findOpenStatements(
      String(orgId),
      '1125',
      new Date(),
    );
    // pending + posted are open; cancelled is excluded.
    expect(open.map((d) => d.externalRef).sort()).toEqual(['sttl-001', 'sttl-002']);
  });
});
