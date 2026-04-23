/**
 * CurrencyExchangeRate Repository
 *
 * Extends mongokit Repository — inherits CRUD, pagination, hooks.
 * One domain method: getRate() for bridge consumption.
 */

import { Repository } from '@classytic/mongokit';
import type { ICurrencyExchangeRate } from './exchange-rate.model.js';
import CurrencyExchangeRate from './exchange-rate.model.js';

class CurrencyExchangeRateRepository extends Repository<ICurrencyExchangeRate> {
  constructor() {
    super(CurrencyExchangeRate, [], { maxLimit: 500 });
  }

  /**
   * Find the closest rate for a currency pair on or before a given date.
   * Falls back to the most recent rate if no exact date match.
   */
  async getRate(
    fromCurrency: string,
    toCurrency: string,
    date: Date,
    purpose: 'buying' | 'selling' | 'general' = 'general',
  ): Promise<number | null> {
    if (fromCurrency === toCurrency) return 1;

    const doc = await this.Model.findOne({
      fromCurrency: fromCurrency.toUpperCase(),
      toCurrency: toCurrency.toUpperCase(),
      date: { $lte: date },
      purpose,
    })
      .sort({ date: -1 })
      .lean();

    if (doc) return doc.rate;

    // Fallback: try 'general' purpose if specific purpose not found
    if (purpose !== 'general') {
      const fallback = await this.Model.findOne({
        fromCurrency: fromCurrency.toUpperCase(),
        toCurrency: toCurrency.toUpperCase(),
        date: { $lte: date },
        purpose: 'general',
      })
        .sort({ date: -1 })
        .lean();
      return fallback?.rate ?? null;
    }

    return null;
  }
}

const exchangeRateRepository = new CurrencyExchangeRateRepository();
export default exchangeRateRepository;
