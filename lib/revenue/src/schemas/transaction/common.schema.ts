/**
 * Common Transaction Schemas
 * @classytic/revenue
 *
 * Base schemas shared across transaction types
 */

import { Schema } from 'mongoose';

/**
 * Base metadata schema for transactions
 */
export const baseMetadataSchema = new Schema(
  {
    // Flexible key-value metadata
  },
  { _id: false, strict: false }
);

/**
 * Reference schema for polymorphic associations
 */
export const referenceSchema = {
  referenceId: {
    type: Schema.Types.ObjectId,
    refPath: 'referenceModel',
    index: true,
  },
  referenceModel: {
    type: String,
    enum: ['Subscription', 'Order', 'Membership', 'Booking', 'Invoice'],
  },
};

export default {
  baseMetadataSchema,
  referenceSchema,
};

