/**
 * Commission Schema
 * @classytic/revenue
 *
 * Schema for platform commission tracking
 * Embedded in Transaction model
 */

import { Schema } from 'mongoose';

/**
 * Commission Schema - Embedded in Transaction
 * Tracks platform commission with gateway fee deduction
 *
 * Usage: commission: commissionSchema
 */
export const commissionSchema = new Schema(
  {
    // Commission rate (e.g., 0.10 for 10%)
    rate: {
      type: Number,
      min: 0,
      max: 1,
    },
    // Gross commission amount (before gateway fees)
    grossAmount: {
      type: Number,
      min: 0,
    },
    // Gateway fee rate (e.g., 0.029 for 2.9%)
    gatewayFeeRate: {
      type: Number,
      min: 0,
      max: 1,
    },
    // Gateway fee amount deducted from commission
    gatewayFeeAmount: {
      type: Number,
      min: 0,
    },
    // Net commission (grossAmount - gatewayFeeAmount)
    netAmount: {
      type: Number,
      min: 0,
    },
    // Commission status
    status: {
      type: String,
      enum: ['pending', 'paid', 'waived', 'reversed'],
      default: 'pending',
    },
    // For affiliate tracking
    affiliate: {
      recipientId: String,
      recipientType: {
        type: String,
        enum: ['user', 'organization', 'partner'],
      },
      rate: Number,
      grossAmount: Number,
      netAmount: Number,
    },
    // For multi-party splits
    splits: [
      {
        type: String,
        recipientId: String,
        rate: Number,
        grossAmount: Number,
        netAmount: Number,
      },
    ],
  },
  { _id: false }
);

export default commissionSchema;

