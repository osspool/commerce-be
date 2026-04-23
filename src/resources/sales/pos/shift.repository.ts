/**
 * POS Shift Repository — extends mongokit Repository.
 *
 * Domain methods live here; standard CRUD is inherited.
 */

import { Repository } from '@classytic/mongokit';
import { ACTIVE_SHIFT_STATES } from './shift.constants.js';
import PosShift, { type IPosShift } from './shift.model.js';

class PosShiftRepository extends Repository<IPosShift> {
  constructor() {
    super(PosShift as never, [], { maxLimit: 50 });
  }

  /**
   * Active shift for a branch = open | paused | blind_closed.
   * Returns null if none exists. Thanks to the partial unique index, this
   * always returns at most one document.
   */
  async getActiveShift(organizationId: string) {
    return this.Model.findOne({
      organizationId,
      state: { $in: ACTIVE_SHIFT_STATES as unknown as string[] },
    }).lean();
  }

  /** @deprecated Use getActiveShift — kept until callers are migrated in P2. */
  async getCurrentShift(organizationId: string) {
    return this.getActiveShift(organizationId);
  }
}

const posShiftRepository = new PosShiftRepository();
export default posShiftRepository;
