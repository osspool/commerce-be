/**
 * Gateway Schema
 * @classytic/revenue
 *
 * Schema for payment gateway information
 */

import { Schema } from 'mongoose';

/**
 * Gateway Schema - Embedded in Transaction
 * Tracks payment gateway details
 */
export const gatewaySchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      sparse: true,
      index: true,
    },
    paymentIntentId: {
      type: String,
      sparse: true,
      index: true,
    },
    provider: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    verificationData: {
      type: Schema.Types.Mixed,
    },
  },
  { _id: false }
);

export default gatewaySchema;

