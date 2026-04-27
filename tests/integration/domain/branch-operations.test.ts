import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { type Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { branchSchema, type IBranch } from '#resources/commerce/branch/branch.model.js';

// ============================================
// SETUP — standalone MongoDB Memory Server
// ============================================

let mongoServer: MongoMemoryServer;
let Branch: Model<IBranch>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { dbName: 'test-branch' } });
  const uri = mongoServer.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri);

  // Register a test-only model using the real branchSchema so pre-save hooks,
  // slug generation, and validation are exercised against the schema definition.
  // We use a unique model name to avoid collisions with the stub model from
  // branch.model.ts (which targets the `organization` collection).
  Branch = mongoose.models.TestBranch as Model<IBranch>
    || mongoose.model<IBranch>('TestBranch', branchSchema);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

beforeEach(async () => {
  await Branch.deleteMany({});
});

// ============================================
// HELPERS
// ============================================

function branchData(overrides: Partial<IBranch> = {}): Partial<IBranch> {
  return {
    code: 'DHK-1',
    name: 'Dhaka Main Store',
    type: 'store',
    role: 'sub_branch',
    isDefault: false,
    isActive: true,
    ...overrides,
  };
}

// ============================================
// TESTS
// ============================================

describe('Branch Model — unique code constraint', () => {
  it('creates a branch with a unique code', async () => {
    const doc = await Branch.create(branchData({ code: 'CTG-1', name: 'Chittagong Outlet' }));

    expect(doc.code).toBe('CTG-1');
    expect(doc.name).toBe('Chittagong Outlet');
    expect(doc.type).toBe('store');
    expect(doc.isActive).toBe(true);
    expect(doc._id).toBeDefined();
  });

  it('rejects duplicate branch codes (uppercased)', async () => {
    await Branch.create(branchData({ code: 'DHK-1' }));

    await expect(
      Branch.create(branchData({ code: 'DHK-1', name: 'Duplicate Branch' })),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it('stores code as uppercase via schema trim/uppercase', async () => {
    const doc = await Branch.create(branchData({ code: 'ctg-lower' as any }));
    expect(doc.code).toBe('CTG-LOWER');
  });
});

describe('Branch Model — slug generation from name', () => {
  it('auto-generates a URL-friendly slug from the branch name', async () => {
    const doc = await Branch.create(branchData({ name: 'Gulshan Avenue Store' }));

    // Slug plugin generates a kebab-case slug
    expect(doc.slug).toBeDefined();
    expect(doc.slug).toMatch(/gulshan-avenue-store/);
  });

  it('generates unique slugs for branches with the same name', async () => {
    const a = await Branch.create(branchData({ code: 'A-1', name: 'Main Store' }));
    const b = await Branch.create(branchData({ code: 'A-2', name: 'Main Store' }));

    expect(a.slug).toBeDefined();
    expect(b.slug).toBeDefined();
    expect(a.slug).not.toBe(b.slug);
  });
});

describe('Branch Model — default branch enforcement', () => {
  it('allows setting a branch as default', async () => {
    const doc = await Branch.create(branchData({ isDefault: true }));
    expect(doc.isDefault).toBe(true);
  });

  it('ensures only one branch is default at a time (pre-save hook)', async () => {
    const first = await Branch.create(branchData({ code: 'B-1', name: 'Branch 1', isDefault: true }));
    const second = await Branch.create(branchData({ code: 'B-2', name: 'Branch 2', isDefault: true }));

    // After second branch is saved as default, first should be unset
    const refreshedFirst = await Branch.findById(first._id).lean();
    const refreshedSecond = await Branch.findById(second._id).lean();

    expect(refreshedSecond!.isDefault).toBe(true);
    expect(refreshedFirst!.isDefault).toBe(false);
  });

  it('ensures only one default via findOneAndUpdate', async () => {
    const a = await Branch.create(branchData({ code: 'C-1', name: 'C1', isDefault: true }));
    const b = await Branch.create(branchData({ code: 'C-2', name: 'C2', isDefault: false }));

    await Branch.findOneAndUpdate({ _id: b._id }, { isDefault: true });

    const refreshedA = await Branch.findById(a._id).lean();
    const refreshedB = await Branch.findById(b._id).lean();

    expect(refreshedB!.isDefault).toBe(true);
    expect(refreshedA!.isDefault).toBe(false);
  });
});

describe('Branch Model — active branches', () => {
  it('returns only active branches when filtering', async () => {
    await Branch.create(branchData({ code: 'D-1', name: 'Active 1', isActive: true }));
    await Branch.create(branchData({ code: 'D-2', name: 'Active 2', isActive: true }));
    await Branch.create(branchData({ code: 'D-3', name: 'Inactive', isActive: false }));

    const active = await Branch.find({ isActive: true }).lean();

    expect(active).toHaveLength(2);
    expect(active.every((b) => b.isActive)).toBe(true);
  });

  it('deactivated branch is excluded from active queries', async () => {
    const doc = await Branch.create(branchData({ code: 'E-1', name: 'To Deactivate' }));

    await Branch.findByIdAndUpdate(doc._id, { isActive: false });

    const active = await Branch.find({ isActive: true }).lean();
    expect(active).toHaveLength(0);

    const all = await Branch.find({}).lean();
    expect(all).toHaveLength(1);
    expect(all[0].isActive).toBe(false);
  });
});

describe('Branch Model — head office role assignment', () => {
  it('only one branch can be head_office at a time (pre-save hook)', async () => {
    const hq = await Branch.create(branchData({ code: 'HQ-1', name: 'HQ', role: 'head_office' }));
    const newHq = await Branch.create(branchData({ code: 'HQ-2', name: 'New HQ', role: 'head_office' }));

    const refreshedHq = await Branch.findById(hq._id).lean();
    const refreshedNewHq = await Branch.findById(newHq._id).lean();

    expect(refreshedNewHq!.role).toBe('head_office');
    expect(refreshedHq!.role).toBe('sub_branch');
  });

  it('only one head_office via findOneAndUpdate', async () => {
    const a = await Branch.create(branchData({ code: 'F-1', name: 'F1', role: 'head_office' }));
    const b = await Branch.create(branchData({ code: 'F-2', name: 'F2', role: 'sub_branch' }));

    await Branch.findOneAndUpdate({ _id: b._id }, { role: 'head_office' });

    const refreshedA = await Branch.findById(a._id).lean();
    const refreshedB = await Branch.findById(b._id).lean();

    expect(refreshedB!.role).toBe('head_office');
    expect(refreshedA!.role).toBe('sub_branch');
  });

  it('sub_branch is the default role', async () => {
    const doc = await Branch.create({ code: 'G-1', name: 'No Role Set' });
    expect(doc.role).toBe('sub_branch');
  });
});

describe('Branch Model — address and contact defaults', () => {
  it('defaults address country to Bangladesh', async () => {
    const doc = await Branch.create(branchData({
      code: 'ADDR-1',
      name: 'Address Test',
      address: { city: 'Dhaka', line1: '123 Main' },
    }));

    expect(doc.address?.country).toBe('Bangladesh');
    expect(doc.address?.city).toBe('Dhaka');
  });

  it('stores email as lowercase', async () => {
    const doc = await Branch.create(branchData({
      code: 'EMAIL-1',
      name: 'Email Test',
      email: 'Store@EXAMPLE.com',
    }));

    expect(doc.email).toBe('store@example.com');
  });

  it('defaults operating hours', async () => {
    const doc = await Branch.create(branchData({ code: 'HOURS-1', name: 'Hours Test' }));
    expect(doc.operatingHours).toBe('10:00 AM - 10:00 PM');
  });
});

describe('Branch Model — branch deactivation', () => {
  it('deactivation preserves all branch data', async () => {
    const doc = await Branch.create(branchData({
      code: 'DEACT-1',
      name: 'Deactivation Test',
      phone: '01712345678',
      address: { city: 'Sylhet' },
    }));

    await Branch.findByIdAndUpdate(doc._id, { isActive: false });

    const deactivated = await Branch.findById(doc._id).lean();
    expect(deactivated!.isActive).toBe(false);
    expect(deactivated!.name).toBe('Deactivation Test');
    expect(deactivated!.phone).toBe('01712345678');
    expect(deactivated!.code).toBe('DEACT-1');
    expect(deactivated!.address?.city).toBe('Sylhet');
  });

  it('can reactivate a previously deactivated branch', async () => {
    const doc = await Branch.create(branchData({ code: 'REACT-1', name: 'Reactivate', isActive: false }));

    await Branch.findByIdAndUpdate(doc._id, { isActive: true });

    const reactivated = await Branch.findById(doc._id).lean();
    expect(reactivated!.isActive).toBe(true);
  });
});

describe('Branch Model — query by code', () => {
  it('retrieves a branch by its unique code', async () => {
    await Branch.create(branchData({ code: 'QUERY-1', name: 'Query Branch' }));

    const found = await Branch.findOne({ code: 'QUERY-1' }).lean();
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Query Branch');
  });

  it('returns null for non-existent code', async () => {
    const found = await Branch.findOne({ code: 'NOPE' }).lean();
    expect(found).toBeNull();
  });
});
