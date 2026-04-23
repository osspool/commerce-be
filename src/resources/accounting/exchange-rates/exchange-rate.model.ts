/**
 * CurrencyExchangeRate — manual exchange rate entries.
 *
 * Hosts enter rates here (or a cron populates from Bangladesh Bank API).
 * The ManualRateBridge reads from this collection when the accounting
 * engine or posting contracts need a rate for a foreign currency pair.
 *
 * One rate per (fromCurrency, toCurrency, date, purpose) — unique index
 * prevents duplicates. When multiple rates exist for the same date (buying
 * vs selling), the `purpose` discriminator separates them.
 */

import mongoose, { type HydratedDocument, type Model, Schema } from 'mongoose';

export interface ICurrencyExchangeRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  date: Date;
  purpose: 'buying' | 'selling' | 'general';
  source?: string;
  notes?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CurrencyExchangeRateDocument = HydratedDocument<ICurrencyExchangeRate>;

const schema = new Schema<ICurrencyExchangeRate>(
  {
    fromCurrency: { type: String, required: true, uppercase: true, trim: true },
    toCurrency: { type: String, required: true, uppercase: true, trim: true },
    rate: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => v > 0,
        message: 'Exchange rate must be positive',
      },
    },
    date: { type: Date, required: true },
    purpose: {
      type: String,
      enum: ['buying', 'selling', 'general'],
      default: 'general',
    },
    source: { type: String, trim: true },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// One rate per pair+date+purpose
schema.index({ fromCurrency: 1, toCurrency: 1, date: 1, purpose: 1 }, { unique: true });
// Lookup by date range for a pair
schema.index({ fromCurrency: 1, toCurrency: 1, date: -1 });

const CurrencyExchangeRate = mongoose.model<ICurrencyExchangeRate>('CurrencyExchangeRate', schema);

export default CurrencyExchangeRate;
