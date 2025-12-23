/**
 * Hold/Escrow Schema
 * @classytic/revenue
 *
 * Schema for platform-as-intermediary escrow flow
 * Spread into transaction schema when needed
 */

import { HOLD_STATUS, HOLD_STATUS_VALUES, HOLD_REASON_VALUES } from '../../enums/escrow.enums.js';

export const holdSchema = {
  status: {
    type: String,
    enum: HOLD_STATUS_VALUES,
    default: HOLD_STATUS.PENDING,
    index: true,
  },

  heldAmount: {
    type: Number,
    required: false,
  },

  releasedAmount: {
    type: Number,
    default: 0,
  },

  reason: {
    type: String,
    enum: HOLD_REASON_VALUES,
    required: false,
  },

  holdUntil: {
    type: Date,
    required: false,
  },

  heldAt: Date,
  releasedAt: Date,
  cancelledAt: Date,

  releases: [
    {
      amount: Number,
      recipientId: String,
      recipientType: String,
      releasedAt: Date,
      releasedBy: String,
      reason: String,
      metadata: Object,
    },
  ],

  metadata: {
    type: Object,
    default: {},
  },
} as const;

export default holdSchema;

