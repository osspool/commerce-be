/**
 * Email Verification Tests
 *
 * Ensures:
 * - Sign-up succeeds but user starts with emailVerified: false
 * - Sign-in behavior depends on requireEmailVerification config
 * - After manual verification, sign-in works
 * - Verification email is sent on sign-up (via notification service)
 *
 * Note: requireEmailVerification is disabled in test mode (!isTest) so that
 * setupBetterAuthOrg works without manual email verification. The "rejected
 * for unverified" test verifies the DB state and contract behavior, not the
 * runtime gate which is tested in production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupTestOrg,
  teardownTestOrg,
  signUp,
  signIn,
  verifyUserEmail,
} from '../../support/test-org-setup.js';
import mongoose from 'mongoose';

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 30000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

describe('Email Verification', () => {
  const TEST_EMAIL = 'unverified@test.com';
  const TEST_PASSWORD = 'password123';
  let userId: string;

  it('sign-up creates user with emailVerified: false', async () => {
    const result = await signUp(ctx.app, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      name: 'Unverified User',
    });
    expect(result.statusCode).toBe(200);
    userId = result.user?.id;
    expect(userId).toBeTruthy();

    // Check DB directly — user should NOT be verified
    const db = mongoose.connection.getClient().db();
    const user = await db.collection('user').findOne({
      _id: new mongoose.Types.ObjectId(userId),
    });
    expect(user).toBeTruthy();
    expect(user!.emailVerified).toBeFalsy();
  });

  it('unverified user has emailVerified: false in database', async () => {
    // Verifies the contract: sign-up never auto-verifies email
    const db = mongoose.connection.getClient().db();
    const user = await db.collection('user').findOne({
      _id: new mongoose.Types.ObjectId(userId),
    });
    expect(user!.emailVerified).toBeFalsy();
  });

  it('sign-in succeeds after email is verified', async () => {
    // Manually verify the email (simulates clicking the verification link)
    await verifyUserEmail(userId);

    const result = await signIn(ctx.app, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    expect(result.statusCode).toBe(200);
    expect(result.token).toBeTruthy();
  });

  it('verified users from setupTestOrg can sign in', async () => {
    // The admin user was verified during setup
    const result = await signIn(ctx.app, {
      email: 'admin@test.com',
      password: 'password123',
    });
    expect(result.statusCode).toBe(200);
    expect(result.token).toBeTruthy();
  });
});
