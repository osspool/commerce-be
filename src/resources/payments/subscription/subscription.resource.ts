/**
 * Subscription Resource — recurring billing wiring (T2.7).
 *
 * **DORMANT IN DEMO.** Commerce BD is single-business multi-branch
 * (Nike-BD model). The eventual billing model is *one* subscription row
 * representing the business itself paying the platform (us) a
 * tier-based monthly fee — NOT per-branch, NOT per-customer subscription
 * products. Until that goes live, this resource has zero rows in
 * production and the hourly cron tick is a no-op finding zero candidates.
 *
 * When the platform-fee model activates, the order of operations is:
 *   1. Decide tier mapping (sme / standard / enterprise → fee amount).
 *   2. Tighten permissions to `platformAdminOnly()` and drop the
 *      `orgScoped` preset — platform billing isn't tenant-scoped.
 *   3. Seed one subscription row per onboarded business (or auto-seed
 *      from a Better Auth `org.created` hook).
 *
 * Wraps `@classytic/revenue`'s `SubscriptionRepository` (kernel ships
 * the FSM + state machine + Zod schemas — pure composition).
 *
 * Auto-list/get/update/delete via the Arc adapter. Custom POST `/` for
 * create — `metadata.nextBillingDate` + `metadata.intervalDays` are
 * host-side state and the auto-derived shape doesn't model them cleanly.
 *
 * Actions: `pause` / `resume` / `cancel` map directly to kernel FSM
 * verbs. The recurring-billing tick lives in
 * [cron/process-billing-due.ts] and is registered in `cron/index.ts`.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { subscriptionActions } from './actions/subscription.actions.js';
import { createSubscriptionHandler } from './handlers/create.handler.js';
import { subscriptionAdapter } from './subscription.adapter.js';
import { createSubscriptionSchema } from './schemas/subscription.schemas.js';

const subscriptionResource = defineResource({
  name: 'subscription',
  displayName: 'Subscriptions',
  tag: 'Payments',
  prefix: '/subscriptions',
  audit: true,

  adapter: subscriptionAdapter,
  queryParser,
  presets: [orgScoped],
  disabledRoutes: ['create'],

  permissions: {
    list: permissions.transactions.list,
    get: permissions.transactions.get,
    create: permissions.transactions.create,
    update: permissions.transactions.update,
    delete: permissions.transactions.delete,
  },

  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create a recurring subscription',
      permissions: permissions.transactions.create,
      raw: true,
      schema: createSubscriptionSchema,
      handler: createSubscriptionHandler,
    },
  ],

  actions: subscriptionActions,
});

export default subscriptionResource;
