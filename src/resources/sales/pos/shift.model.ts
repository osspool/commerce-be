/**
 * Shim — POS shift model now lives in `@classytic/pos`.
 *
 * Existing importers used `import PosShift, { type IPosShift, type PosShiftDocument }
 * from './shift.model.js'` — keep that surface working by re-exporting the
 * package's model + types via the engine singleton. New code should import
 * from `@classytic/pos` directly.
 */

import type { IShift, ShiftDocument } from '@classytic/pos';
import { posEngine } from './pos.engine.js';

const PosShift = posEngine.models.Shift;

export type IPosShift = IShift;
export type PosShiftDocument = ShiftDocument;

export default PosShift;
