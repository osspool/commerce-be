/**
 * Subscription Info Schema
 * @classytic/revenue
 *
 * Schema for subscription information embedded in entities
 */

import { Schema } from 'mongoose';
import { SUBSCRIPTION_STATUS_VALUES, PLAN_KEY_VALUES } from '../../enums/subscription.enums.js';

/**
 * Subscription Info Schema
 * Use this in your entity models that have subscriptions
 *
 * @example
 * const OrganizationSchema = new Schema({
 *   name: String,
 *   subscription: { type: subscriptionInfoSchema },
 * });
 */
export const subscriptionInfoSchema = new Schema(
  {
    planKey: {
      type: String,
      enum: PLAN_KEY_VALUES,
      required: true,
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUS_VALUES,
      default: 'pending',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
      index: true,
    },
    canceledAt: {
      type: Date,
    },
    cancelAt: {
      type: Date,
    },
    pausedAt: {
      type: Date,
    },
    lastPaymentDate: {
      type: Date,
    },
    lastPaymentAmount: {
      type: Number,
    },
    renewalCount: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

export default subscriptionInfoSchema;

