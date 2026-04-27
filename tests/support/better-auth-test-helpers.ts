/**
 * Better Auth test helpers — backward-compat shim over Arc 2.11.
 *
 * Arc 2.11's testing rewrite replaced `setupBetterAuthOrg` (which accepted
 * a `createApp: () => Promise<FastifyInstance>` factory) with
 * `setupBetterAuthTestApp` (which requires a caller-owned `app`). Migrating
 * 50+ commerce test files to the new shape one at a time is high-risk; this
 * shim lets every test keep the old `setupBetterAuthOrg({ createApp, ... })`
 * call and internally adapts to the new Arc contract.
 *
 * New tests should consume `setupBetterAuthTestApp` from `@classytic/arc/testing`
 * directly and manage the Fastify lifecycle themselves.
 */

import type { FastifyInstance } from 'fastify';
import {
  createBetterAuthProvider,
  setupBetterAuthTestApp,
  type SetupBetterAuthTestAppInput,
  type SetupBetterAuthTestAppResult,
  type TestAuthProvider,
} from '@classytic/arc/testing';

export { createBetterAuthProvider, type TestAuthProvider };
export type { SetupBetterAuthTestAppResult as TestOrgContext };

/** Alias — legacy name used across be-prod tests. */
export type AuthProvider = TestAuthProvider;

export interface SetupBetterAuthOrgInput
  extends Omit<SetupBetterAuthTestAppInput, 'app'> {
  /**
   * Lazily build the Fastify app. The shim awaits this before delegating
   * to `setupBetterAuthTestApp`, matching pre-2.11 semantics where the
   * helper owned the app lifecycle.
   */
  createApp: () => Promise<FastifyInstance>;
}

export async function setupBetterAuthOrg(
  input: SetupBetterAuthOrgInput,
): Promise<SetupBetterAuthTestAppResult & { app: FastifyInstance }> {
  const { createApp, ...rest } = input;
  const app = await createApp();
  const result = await setupBetterAuthTestApp({ app, ...rest });
  return { ...result, app };
}

/**
 * Backward-compat alias — many in-flight migrations import the 2.11 name
 * but still pass `createApp: () => ...`. The alias keeps those call sites
 * compiling against the legacy signature until they migrate.
 */
export const setupBetterAuthTestAppCompat = setupBetterAuthOrg;

export function safeParseBody<T = unknown>(body: string | undefined): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
