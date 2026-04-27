/**
 * Supplier CRUD — Arc HttpTestHarness coverage.
 *
 * Replaces the hand-rolled Supplier CRUD `it()` blocks in
 * `inventory-e2e.test.ts` (lines ~94-145). The harness generates the
 * full CRUD + permissions + validation matrix from one resource
 * definition — gains 4 missing edge-case tests (404 on GET/PATCH/DELETE
 * for unknown ID, 400 on invalid payload) at zero marginal cost.
 *
 * The deferred-getter form (`createHttpTestHarness(resource, () => ({ ... }))`)
 * is required because `bootScenarioApp` is async — the app + auth provider
 * aren't ready at module-eval time.
 */

import { afterAll, beforeAll } from 'vitest'; import { createHttpTestHarness } from '@classytic/arc/testing';

import supplierResource from '#resources/inventory/supplier/supplier.resource.js';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'sup-crud' });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

createHttpTestHarness(supplierResource, () => ({
  app: env.server,
  apiPrefix: '/api/v1',
  auth: env.auth,
  // Arc 2.11's canonical TestAuthProvider has no `adminRole` field — the
  // harness takes it as an explicit option. `bootScenarioApp` registers the
  // admin user under the `'admin'` role key.
  adminRole: 'admin',
  fixtures: {
    // Required fields per the supplier model: name + paymentTerms.
    // type, phone, paymentTerms align with the existing inventory-e2e
    // hand-rolled test so behaviour matches.
    valid: {
      name: `Harness Supplier ${Date.now()}`,
      type: 'local',
      phone: '01700000000',
      paymentTerms: 'cash',
    } as never,
    update: { name: 'Updated Supplier' } as never,
    // Empty payload — supplier requires `name` so this MUST 400.
    invalid: {} as never,
  },
})).runAll();
