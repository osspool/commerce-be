/**
 * Seed Script — Better Auth Users + Branches
 *
 * Creates:
 * 1. Admin user (admin@bigboss.com / bigboss@2026) with superadmin role
 * 2. Head Office branch (organization)
 * 3. Dhaka Store branch (organization)
 * 4. Admin as branch_manager of both
 *
 * Usage: node scripts/seed-auth.js
 */

import '../config/env-loader.js';
import mongoose from 'mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import { getAuth } from '../modules/auth/auth.config.js';

const MONGO_URI = process.env.MONGO_URI;

async function seed() {
  console.log('🌱 Connecting to MongoDB...');
  // Connect mongoose (needed for getAuth to register stub models)
  await mongoose.connect(MONGO_URI);
  // Use native MongoClient for direct DB ops (avoids bson mismatch)
  const nativeClient = new MongoClient(MONGO_URI);
  await nativeClient.connect();
  const db = nativeClient.db();
  console.log('✅ Connected to:', MONGO_URI.replace(/\/\/.*@/, '//***@'));

  const auth = getAuth();
  const collections = ['user', 'session', 'account', 'organization', 'member', 'invitation'];
  for (const col of collections) {
    try {
      await db.collection(col).deleteMany({});
      console.log(`  Cleared: ${col}`);
    } catch {
      // Collection may not exist yet
    }
  }

  // 1. Create admin user
  console.log('\n👤 Creating admin user...');
  const ctx = await auth.api.signUpEmail({
    body: {
      name: 'BigBoss Admin',
      email: 'admin@bigboss.com',
      password: 'bigboss@2026',
    },
  });

  const userId = ctx.user.id;
  console.log('  User ID:', userId);
  console.log('  Email:', ctx.user.email);

  // Update role to superadmin
  await db.collection('user').updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        role: ['superadmin', 'admin'],
        isActive: true,
        phone: '+8801700000000',
      },
    },
  );
  console.log('  Role set to: superadmin, admin');

  // Get session headers for authenticated API calls
  const sessionToken = ctx.token;
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${sessionToken}`);

  // 2. Create Head Office branch
  console.log('\n🏢 Creating Head Office branch...');
  const hoResult = await auth.api.createOrganization({
    body: {
      name: 'Head Office',
      slug: 'head-office',
      metadata: {
        code: 'HO-001',
        branchType: 'warehouse',
        branchRole: 'head_office',
      },
    },
    headers,
  });

  const hoOrgId = hoResult.id;
  console.log('  Org ID:', hoOrgId);

  // Set additional branch fields directly
  await db.collection('organization').updateOne(
    { _id: new ObjectId(hoOrgId) },
    {
      $set: {
        code: 'HO-001',
        branchType: 'warehouse',
        branchRole: 'head_office',
        isDefault: true,
        isActive: true,
        phone: '+8801700000000',
      },
    },
  );
  console.log('  Branch role: head_office (default)');

  // 3. Create Dhaka Store branch
  console.log('\n🏪 Creating Dhaka Store branch...');
  const dsResult = await auth.api.createOrganization({
    body: {
      name: 'Dhaka Store',
      slug: 'dhaka-store',
      metadata: {
        code: 'DHK-001',
        branchType: 'store',
        branchRole: 'sub_branch',
      },
    },
    headers,
  });

  const dsOrgId = dsResult.id;
  console.log('  Org ID:', dsOrgId);

  await db.collection('organization').updateOne(
    { _id: new ObjectId(dsOrgId) },
    {
      $set: {
        code: 'DHK-001',
        branchType: 'store',
        branchRole: 'sub_branch',
        isDefault: false,
        isActive: true,
      },
    },
  );
  console.log('  Branch role: sub_branch');

  // 4. Set active organization to head office
  await auth.api.setActiveOrganization({
    body: { organizationId: hoOrgId },
    headers,
  });
  console.log('\n✅ Active organization set to Head Office');

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('🎉 Seed completed successfully!');
  console.log('='.repeat(50));
  console.log('\nAdmin credentials:');
  console.log('  Email:    admin@bigboss.com');
  console.log('  Password: bigboss@2026');
  console.log('  Roles:    superadmin, admin');
  console.log('\nBranches:');
  console.log(`  Head Office (${hoOrgId}) — head_office, default`);
  console.log(`  Dhaka Store (${dsOrgId}) — sub_branch`);
  console.log('\nAdmin is branch_manager of both branches.');

  await nativeClient.close();
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
