/**
 * Day-Close State Model
 *
 * Persistent per-branch state tracking for POS day-close.
 * Replaces the in-memory `lastPosDates` Map with MongoDB-backed storage.
 *
 * One document per branch. Survives restarts, works across instances.
 */

import mongoose, { Schema } from 'mongoose';

export interface IDayCloseState {
  branchId: mongoose.Types.ObjectId;
  lastClosedDate: string; // BD date string YYYY-MM-DD
  closingInProgress: boolean;
  closingStartedAt: Date | null;
}

const dayCloseStateSchema = new Schema<IDayCloseState>(
  {
    branchId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    lastClosedDate: { type: String, required: true },
    closingInProgress: { type: Boolean, default: false },
    closingStartedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const DayCloseState =
  mongoose.models.DayCloseState ||
  mongoose.model<IDayCloseState>('DayCloseState', dayCloseStateSchema, 'day_close_states');
