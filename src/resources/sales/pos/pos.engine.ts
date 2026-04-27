/**
 * POS engine singleton for be-prod.
 *
 * Wraps `@classytic/pos`'s `createPosEngine` with the host's wiring:
 *   - LedgerBridge → posts the canonical sales JE on shift close.
 *   - PolicyBridge → resolves per-branch policy via `shift-policy.resolver`.
 *   - NotificationBridge → routes variance + orphan alerts to fastify logger.
 *
 * The package owns models, FSM, and variance math. This file is the seam
 * between domain logic (in the package) and host-specific concerns (chart
 * of accounts, branch policy, notifications).
 *
 * Mirrors the `accounting.engine` pattern: top-level eager singleton —
 * Mongoose model registration only requires `mongoose.connection` to exist;
 * queries queue or fail until `connectDatabase()` runs at app boot.
 */

import { createPosEngine, type PosEngine } from '@classytic/pos';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { shiftLedgerBridge } from '../../accounting/posting/contracts/shift.contract.js';
import { resolveShiftPolicy } from './shift-policy.resolver.js';
import { DEFAULT_SHIFT_POLICY } from './shift.constants.js';

export const posEngine: PosEngine = createPosEngine({
  connection: mongoose.connection,

  // Default policy seeded from be-prod's existing `DEFAULT_SHIFT_POLICY` so
  // current deployments see no behavior change. Per-branch overrides flow
  // through the policy bridge below.
  defaultPolicy: DEFAULT_SHIFT_POLICY,

  bridges: {
    ledger: shiftLedgerBridge,
    policy: {
      async resolvePolicy(ctx) {
        const orgId = (ctx.organizationId as string | undefined) ?? '';
        return resolveShiftPolicy(orgId);
      },
    },
  },

  // organizationId on PosShift = Better Auth org id (ObjectId). Matches
  // the rest of be-prod's per-branch scoping.
  tenantFieldType: 'objectId',

  // Enable Mongoose autoIndex so the partial-unique-active-shift constraint
  // and orphan-lookup indexes are pushed to MongoDB on first model use. The
  // alternative is to call `posEngine.models.Shift.syncIndexes()` at boot;
  // until the boot pipeline grows that hook, autoIndex keeps the unique
  // guard live in dev/test/prod uniformly.
  autoIndex: true,
});

// ─── Event bridge: package events → be-prod's arcEvents outbox ─────────────
// The package emits `pos:shift.opened`, `.closed`, `.force_closed`, etc. to
// its in-process bus. Forward each one through `arcEvents.publish` so the
// host's durable outbox + downstream subscribers (audit dashboards,
// notification handlers, BI pipelines) see them. The package's bus
// continues to deliver to in-process listeners — this is additive.
posEngine.events
  .subscribe('pos:*', async (event) => {
    try {
      await publish(event.type, event.payload as Record<string, unknown>);
    } catch (err) {
      logger.error({ err, type: event.type }, 'Failed to forward pos event to outbox');
    }
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'Failed to subscribe pos events to outbox forwarder');
  });
