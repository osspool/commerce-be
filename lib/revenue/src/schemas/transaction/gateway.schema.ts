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
    },
    sessionId: {
      type: String,
      sparse: true,
    },
    paymentIntentId: {
      type: String,
      sparse: true,
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
