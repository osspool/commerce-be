/**
 * Split Schema
 * @classytic/revenue
 *
 * Schema for multi-party commission splits
 */

import { Schema } from 'mongoose';
import {
  SPLIT_TYPE_VALUES,
  SPLIT_STATUS,
  SPLIT_STATUS_VALUES,
  PAYOUT_METHOD_VALUES,
} from '../../enums/split.enums.js';

/**
 * Split Schema - Embedded in Transaction
 */
export const splitSchema = new Schema(
  {
    type: {
      type: String,
      enum: SPLIT_TYPE_VALUES,
      required: true,
    },
    recipientId: {
      type: String,
      required: true,
      index: true,
    },
    recipientType: {
      type: String,
      enum: ['platform', 'organization', 'user', 'affiliate', 'partner'],
      required: true,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    grossAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    gatewayFeeRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    gatewayFeeAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: SPLIT_STATUS_VALUES,
      default: SPLIT_STATUS.PENDING,
      index: true,
    },
    dueDate: {
      type: Date,
    },
    paidDate: {
      type: Date,
    },
    payoutMethod: {
      type: String,
      enum: PAYOUT_METHOD_VALUES,
    },
    payoutTransactionId: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

export default splitSchema;

