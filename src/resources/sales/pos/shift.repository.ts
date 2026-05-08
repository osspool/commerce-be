/**
 * Shim — repository now lives in `@classytic/pos`.
 *
 * Adds the `getActiveShift` legacy helper as a thin wrapper so existing
 * call sites (handlers, dashboards, reports) keep working without changes.
 * New code should import `posEngine.repositories.shift` from
 * `pos.engine.ts` directly and call domain verbs there.
 */

import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { posEngine } from './pos.engine.js';
import { ACTIVE_SHIFT_STATES } from './shift.constants.js';

const repo = posEngine.repositories.shift;

// Augment the package repo with the legacy helper. The package repo's
// `getAll` is the canonical filter path now; `getActiveShift` is a
// convenience over it.
const augmented = Object.assign(repo, {
  /**
   * Active shift for a branch = open | paused | blind_closed.
   * Returns null when none. Always at most one (partial unique index).
   *
   * `organizationId` is stored as ObjectId in the schema (tenantFieldType:
   * 'objectId'); cast string args explicitly so the query matches.
   */
  async getActiveShift(organizationId: string) {
    const orgObjectId = mongoose.Types.ObjectId.isValid(organizationId)
      ? new mongoose.Types.ObjectId(organizationId)
      : organizationId;
    const result = await posEngine.models.Shift.findOne({
      organizationId: orgObjectId,
      state: { $in: [...ACTIVE_SHIFT_STATES] },
    }).lean();
    if (!result && process.env.LOG_LEVEL === 'debug') {
      logger.debug(
        { orgId: String(organizationId), states: ACTIVE_SHIFT_STATES },
        'pos:getActiveShift returned null',
      );
    }
    return result;
  },
});

const posShiftRepository = augmented;

export default posShiftRepository;
