/**
 * Plan Schema
 * @classytic/revenue
 *
 * Schema for subscription plans
 */

import { Schema } from 'mongoose';
import { PLAN_KEY_VALUES } from '../../enums/subscription.enums.js';

/**
 * Plan Schema - for defining subscription plans
 */
export const planSchema = new Schema(
  {
    key: {
      type: String,
      enum: PLAN_KEY_VALUES,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'BDT',
    },
    interval: {
      type: String,
      enum: ['day', 'week', 'month', 'year'],
      default: 'month',
    },
    intervalCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    features: [
      {
        type: String,
      },
    ],
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

export default planSchema;

