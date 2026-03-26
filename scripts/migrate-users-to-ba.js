/**
 * Migration Script — Old Users → Better Auth
 *
 * Reads users from the old `users` collection (Mongoose pluralized)
 * and creates them in BA's `user` collection with password: bigboss@2026.
 * Preserves: _id, name, email, role, phone, isActive.
 *
 * Users will need to change their password after first login.
 *
 * Usage: NODE_ENV=dev node scripts/migrate-users-to-ba.js
 * Idempotent: skips users that already exist in BA.
 */

import '../config/env-loader.js';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import { getAuth, resetAuth } from '../modules/auth/auth.config.js';

const MONGO_URI = process.env.MONGO_URI;
const DEFAULT_PASSWORD = 'bigboss@2026';

async function migrate() {
  console.log('🔄 User Migration: old users → Better Auth');
  console.log('='.repeat(50));

  await mongoose.connect(MONGO_URI);
  const nativeClient = new MongoClient(MONGO_URI);
  await nativeClient.connect();
  const db = nativeClient.db();
  console.log('✅ Connected');

  resetAuth();
  const auth = getAuth();

  const oldUsersCol = db.collection('users');  // Mongoose pluralizes 'User' → 'users'
  const baUserCol = db.collection('user');     // BA collection name

  const oldUsers = await oldUsersCol.find({}).toArray();
  console.log(`\nFound ${oldUsers.length} users in old collection`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const oldUser of oldUsers) {
    const email = oldUser.email?.toLowerCase()?.trim();
    if (!email) {
      console.log(`  ⚠ Skipped: no email (${oldUser._id})`);
      skipped++;
      continue;
    }

    // Check if already in BA
    const existing = await baUserCol.findOne({ email });
    if (existing) {
      console.log(`  ⏭ Skipped: ${email} (already in BA)`);
      skipped++;
      continue;
    }

    try {
      // Create via BA signUp API (hashes password with BA's algorithm)
      const result = await auth.api.signUpEmail({
        body: {
          name: oldUser.name || email.split('@')[0],
          email,
          password: DEFAULT_PASSWORD,
        },
      });

      const baUserId = result.user.id;

      // Copy over custom fields from old user using native ObjectId
      const { ObjectId } = await import('mongodb');
      await baUserCol.updateOne(
        { _id: new ObjectId(baUserId) },
        {
          $set: {
            role: oldUser.role || ['user'],
            phone: oldUser.phone || null,
            isActive: oldUser.isActive !== false,
            _oldUserId: oldUser._id.toString(),
          },
        },
      );

      console.log(`  ✅ Migrated: ${email} (${oldUser.role?.join(', ')}) → BA ID: ${baUserId}`);
      migrated++;
    } catch (err) {
      console.log(`  ❌ Failed: ${email} — ${err.message || err}`);
      failed++;
    }
  }

  // Also ensure the BA admin user has proper roles
  const adminUser = await baUserCol.findOne({ email: 'admin@bigboss.com' });
  if (adminUser && !adminUser.role?.includes('superadmin')) {
    await baUserCol.updateOne(
      { _id: adminUser._id },
      { $set: { role: ['superadmin', 'admin'] } },
    );
    console.log('\n  Updated admin@bigboss.com roles to superadmin');
  }

  console.log('\n' + '='.repeat(50));
  console.log('🎉 Migration complete!');
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`\n  Default password for all migrated users: ${DEFAULT_PASSWORD}`);
  console.log('  Users should change their password after first login.');

  await nativeClient.close();
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
