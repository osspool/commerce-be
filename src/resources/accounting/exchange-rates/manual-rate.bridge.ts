/**
 * ManualRateBridge — implements ledger's ExchangeRateBridge
 * using the CurrencyExchangeRate MongoDB collection.
 *
 * Hosts enter rates via the /accounting/exchange-rates CRUD resource.
 * The bridge reads the closest rate on or before the requested date.
 */

import type { ExchangeRateBridge } from '@classytic/ledger';
import exchangeRateRepository from './exchange-rate.repository.js';

export const manualRateBridge: ExchangeRateBridge = {
  async getRate(fromCurrency: string, toCurrency: string, date: Date, purpose?: 'buying' | 'selling'): Promise<number> {
    if (fromCurrency === toCurrency) return 1;

    const rate = await exchangeRateRepository.getRate(fromCurrency, toCurrency, date, purpose ?? 'general');

    if (rate === null) {
      throw new Error(
        `No exchange rate found for ${fromCurrency}→${toCurrency} on ${date.toISOString().slice(0, 10)}. ` +
          `Add a rate via POST /api/v1/accounting/exchange-rates.`,
      );
    }

    return rate;
  },
};
