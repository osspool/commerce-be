/**
 * Migration Script — Branches → Better Auth Organizations (Same _id)
 *
 * SAFE migration: Creates BA organization documents using the SAME _id
 * as existing Branch documents. This means ALL existing branchId references
 * (orders, inventory, transfers, stock entries, etc.) automatically resolve
 * to valid BA organizations — zero document updates needed.
 *
 * Also migrates user branch assignments → BA member records.
 *
 * Steps:
 * 1. Read all existing Branch documents
 * 2. For each, insert into `organization` collection with same _id + BA required fields
 * 3. Read all users with branch assignments
 * 4. For each user-branch pair, create a BA `member` record
 * 5. Seed admin user if not exists (admin@bigboss.com / bigboss@2026)
 *
 * Usage: NODE_ENV=dev node scripts/migrate-branches-to-orgs.js
 *
 * IMPORTANT: Run this ONCE. It's idempotent (skips existing orgs/members).
 */

import '../config/env-loader.js';
import mongoose from 'mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import { getAuth } from '../modules/auth/auth.config.js';

const MONGO_URI = process.env.MONGO_URI;

// Map old branch roles to BA org roles
const BRANCH_ROLE_TO_BA_ROLE = {
  branch_manager: 'branch_manager',
  inventory_staff: 'inventory_staff',
  cashier: 'cashier',
  stock_receiver: 'stock_receiver',
  stock_requester: 'stock_requester',
  viewer: 'viewer',
};

async function migrate() {
  console.log('🔄 Branch → Organization Migration');
  console.log('='.repeat(50));

  // Connect
  await mongoose.connect(MONGO_URI);
  const nativeClient = new MongoClient(MONGO_URI);
  await nativeClient.connect();
  const db = nativeClient.db();
  console.log('✅ Connected to:', MONGO_URI.replace(/\/\/.*@/, '//***@'));

  // Initialize BA (registers stub models)
  const auth = getAuth();

  const branchCol = db.collection('branches'); // Mongoose pluralizes 'Branch' → 'branches'
  const orgCol = db.collection('organization');
  const memberCol = db.collection('member');
  const userCol = db.collection('user');

  // ============================================
  // Step 1: Migrate Branch documents → organization
  // ============================================
  console.log('\n📦 Step 1: Migrating branches to organizations...');

  const branches = await branchCol.find({}).toArray();
  console.log(`  Found ${branches.length} existing branches`);

  let migratedOrgs = 0;
  let skippedOrgs = 0;

  for (const branch of branches) {
    // Check if org with same _id already exists
    const existingOrg = await orgCol.findOne({ _id: branch._id });
    if (existingOrg) {
      console.log(`  ⏭ Skipped: ${branch.name} (${branch.code}) — already migrated`);
      skippedOrgs++;
      continue;
    }

    // Create BA organization with SAME _id as Branch
    const orgDoc = {
      _id: branch._id, // CRITICAL: same ID preserves all references
      name: branch.name,
      slug: branch.slug || branch.code.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      logo: null,
      metadata: null,
      createdAt: branch.createdAt || new Date(),
      // Custom fields (from auth.config.js additionalFields)
      code: branch.code,
      branchType: branch.type || 'store',
      branchRole: branch.role || 'sub_branch',
      address: branch.address ? JSON.stringify(branch.address) : null,
      phone: branch.phone || null,
      isDefault: branch.isDefault || false,
      isActive: branch.isActive !== false,
    };

    await orgCol.insertOne(orgDoc);
    console.log(`  ✅ Migrated: ${branch.name} (${branch.code}) → org ${branch._id}`);
    migratedOrgs++;
  }

  console.log(`  Done: ${migratedOrgs} migrated, ${skippedOrgs} skipped`);

  // ============================================
  // Step 2: Migrate user branch assignments → BA members
  // ============================================
  console.log('\n👥 Step 2: Migrating user branch assignments to BA members...');

  // Find old users with branch assignments (query the original User collection structure)
  // The old User model stored branches in a `branches` array
  const usersWithBranches = await userCol.find({
    $or: [
      { 'branches.0': { $exists: true } },
      { 'branch.branchId': { $exists: true } },
    ],
  }).toArray();

  console.log(`  Found ${usersWithBranches.length} users with branch assignments`);

  let migratedMembers = 0;
  let skippedMembers = 0;

  for (const user of usersWithBranches) {
    const userId = user._id.toString();

    // Collect all branch assignments
    const assignments = [];

    // From branches array
    if (Array.isArray(user.branches)) {
      for (const b of user.branches) {
        if (b.branchId) {
          assignments.push({
            branchId: b.branchId.toString(),
            roles: b.roles || [],
            isPrimary: b.isPrimary || false,
            phone: user.phone,
          });
        }
      }
    }

    // From legacy branch field
    if (user.branch?.branchId && !assignments.find(a => a.branchId === user.branch.branchId.toString())) {
      assignments.push({
        branchId: user.branch.branchId.toString(),
        roles: [],
        isPrimary: assignments.length === 0,
        phone: user.phone,
      });
    }

    for (const assignment of assignments) {
      // Check if org exists for this branch
      const orgExists = await orgCol.findOne({ _id: new ObjectId(assignment.branchId) });
      if (!orgExists) {
        console.log(`  ⚠ Skipped member for user ${userId}: org ${assignment.branchId} not found`);
        continue;
      }

      // Check if member already exists
      const existingMember = await memberCol.findOne({
        userId: new ObjectId(userId),
        organizationId: new ObjectId(assignment.branchId),
      });
      if (existingMember) {
        skippedMembers++;
        continue;
      }

      // Map branch roles to BA org role
      // Take the highest-privilege role, default to 'viewer'
      const roleMap = ['branch_manager', 'inventory_staff', 'cashier', 'stock_receiver', 'stock_requester', 'viewer'];
      let baRole = 'viewer';
      for (const r of roleMap) {
        if (assignment.roles.includes(r)) {
          baRole = r;
          break;
        }
      }

      // If user is admin/superadmin, make them branch_manager
      const userRoles = user.role || [];
      if (userRoles.includes('admin') || userRoles.includes('superadmin')) {
        baRole = 'branch_manager';
      }

      const memberDoc = {
        _id: new ObjectId(),
        userId: new ObjectId(userId),
        organizationId: new ObjectId(assignment.branchId),
        role: baRole,
        createdAt: new Date(),
        // Custom additional fields
        phone: assignment.phone || null,
        status: 'active',
      };

      await memberCol.insertOne(memberDoc);
      migratedMembers++;
    }
  }

  console.log(`  Done: ${migratedMembers} members created, ${skippedMembers} skipped`);

  // ============================================
  // Step 3: Ensure admin user exists with BA
  // ============================================
  console.log('\n👤 Step 3: Ensuring admin user...');

  const adminUser = await userCol.findOne({ email: 'admin@bigboss.com' });

  if (adminUser) {
    console.log(`  Admin exists: ${adminUser._id}`);
    // Ensure superadmin role
    if (!adminUser.role?.includes('superadmin')) {
      await userCol.updateOne(
        { _id: adminUser._id },
        { $set: { role: ['superadmin', 'admin'] } },
      );
      console.log('  Updated role to superadmin');
    }
  } else {
    console.log('  Creating admin user via Better Auth...');
    const ctx = await auth.api.signUpEmail({
      body: {
        name: 'BigBoss Admin',
        email: 'admin@bigboss.com',
        password: 'bigboss@2026',
      },
    });
    await userCol.updateOne(
      { _id: new ObjectId(ctx.user.id) },
      { $set: { role: ['superadmin', 'admin'], isActive: true, phone: '+8801700000000' } },
    );
    console.log(`  Created admin: ${ctx.user.id}`);

    // Add admin as branch_manager of all orgs
    const allOrgs = await orgCol.find({}).toArray();
    for (const org of allOrgs) {
      const exists = await memberCol.findOne({
        userId: new ObjectId(ctx.user.id),
        organizationId: org._id,
      });
      if (!exists) {
        await memberCol.insertOne({
          _id: new ObjectId(),
          userId: new ObjectId(ctx.user.id),
          organizationId: org._id,
          role: 'branch_manager',
          createdAt: new Date(),
          status: 'active',
        });
      }
    }
    console.log(`  Added admin to ${allOrgs.length} branches as branch_manager`);
  }

  // ============================================
  // Step 4: Set default active org for admin
  // ============================================
  const defaultOrg = await orgCol.findOne({ isDefault: true });
  if (defaultOrg && adminUser) {
    // Update admin's session to have activeOrganizationId
    console.log(`\n  Default branch: ${defaultOrg.name} (${defaultOrg._id})`);
  }

  // ============================================
  // Summary
  // ============================================
  const orgCount = await orgCol.countDocuments();
  const memberCount = await memberCol.countDocuments();
  const userCount = await userCol.countDocuments();

  console.log('\n' + '='.repeat(50));
  console.log('🎉 Migration completed!');
  console.log('='.repeat(50));
  console.log(`  Organizations: ${orgCount}`);
  console.log(`  Members: ${memberCount}`);
  console.log(`  Users: ${userCount}`);
  console.log(`\n  Admin: admin@bigboss.com / bigboss@2026`);
  console.log('\n  ⚠ Old Branch collection is preserved (not deleted).');
  console.log('  The branch.resource.js will now query from organization collection.');

  await nativeClient.close();
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
