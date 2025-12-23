/**
 * Money Utility - Integer-safe currency handling
 * @classytic/revenue
 *
 * Never use floating point for money!
 * All amounts stored as smallest unit (cents, paisa, etc.)
 * 
 * Inspired by: Stripe, Dinero.js, tc39/proposal-decimal
 */

export interface MoneyValue {
  /** Amount in smallest currency unit (cents, paisa, etc.) */
  readonly amount: number;
  /** ISO 4217 currency code */
  readonly currency: string;
}

/** Currency configuration */
interface CurrencyConfig {
  code: string;
  decimals: number;
  symbol: string;
  name: string;
}

/** Supported currencies with their decimal places */
const CURRENCIES: Record<string, CurrencyConfig> = {
  USD: { code: 'USD', decimals: 2, symbol: '$', name: 'US Dollar' },
  EUR: { code: 'EUR', decimals: 2, symbol: '€', name: 'Euro' },
  GBP: { code: 'GBP', decimals: 2, symbol: '£', name: 'British Pound' },
  BDT: { code: 'BDT', decimals: 2, symbol: '৳', name: 'Bangladeshi Taka' },
  INR: { code: 'INR', decimals: 2, symbol: '₹', name: 'Indian Rupee' },
  JPY: { code: 'JPY', decimals: 0, symbol: '¥', name: 'Japanese Yen' },
  CNY: { code: 'CNY', decimals: 2, symbol: '¥', name: 'Chinese Yuan' },
  AED: { code: 'AED', decimals: 2, symbol: 'د.إ', name: 'UAE Dirham' },
  SAR: { code: 'SAR', decimals: 2, symbol: '﷼', name: 'Saudi Riyal' },
  SGD: { code: 'SGD', decimals: 2, symbol: 'S$', name: 'Singapore Dollar' },
  AUD: { code: 'AUD', decimals: 2, symbol: 'A$', name: 'Australian Dollar' },
  CAD: { code: 'CAD', decimals: 2, symbol: 'C$', name: 'Canadian Dollar' },
};

/**
 * Money class - immutable money representation
 */
export class Money implements MoneyValue {
  readonly amount: number;
  readonly currency: string;

  private constructor(amount: number, currency: string) {
    if (!Number.isInteger(amount)) {
      throw new Error(`Money amount must be integer (smallest unit). Got: ${amount}`);
    }
    this.amount = amount;
    this.currency = currency.toUpperCase();
  }

  // ============ FACTORY METHODS ============

  /**
   * Create money from smallest unit (cents, paisa)
   * @example Money.cents(1999, 'USD') // $19.99
   */
  static cents(amount: number, currency = 'USD'): Money {
    return new Money(Math.round(amount), currency);
  }

  /**
   * Create money from major unit (dollars, taka)
   * @example Money.of(19.99, 'USD') // $19.99 (stored as 1999 cents)
   */
  static of(amount: number, currency = 'USD'): Money {
    const config = CURRENCIES[currency.toUpperCase()] ?? { decimals: 2 };
    const multiplier = Math.pow(10, config.decimals);
    return new Money(Math.round(amount * multiplier), currency);
  }

  /**
   * Create zero money
   */
  static zero(currency = 'USD'): Money {
    return new Money(0, currency);
  }

  // ============ SHORTHAND FACTORIES ============

  static usd(cents: number): Money { return Money.cents(cents, 'USD'); }
  static eur(cents: number): Money { return Money.cents(cents, 'EUR'); }
  static gbp(pence: number): Money { return Money.cents(pence, 'GBP'); }
  static bdt(paisa: number): Money { return Money.cents(paisa, 'BDT'); }
  static inr(paisa: number): Money { return Money.cents(paisa, 'INR'); }
  static jpy(yen: number): Money { return Money.cents(yen, 'JPY'); }

  // ============ ARITHMETIC ============

  /**
   * Add two money values (must be same currency)
   */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  /**
   * Subtract money (must be same currency)
   */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  /**
   * Multiply by a factor (rounds to nearest integer)
   */
  multiply(factor: number): Money {
    return new Money(Math.round(this.amount * factor), this.currency);
  }

  /**
   * Divide by a divisor (rounds to nearest integer)
   */
  divide(divisor: number): Money {
    if (divisor === 0) throw new Error('Cannot divide by zero');
    return new Money(Math.round(this.amount / divisor), this.currency);
  }

  /**
   * Calculate percentage
   * @example money.percentage(10) // 10% of money
   */
  percentage(percent: number): Money {
    return this.multiply(percent / 100);
  }

  /**
   * Allocate money among recipients (handles rounding)
   * @example Money.usd(100).allocate([1, 1, 1]) // [34, 33, 33] cents
   */
  allocate(ratios: number[]): Money[] {
    const total = ratios.reduce((a, b) => a + b, 0);
    if (total === 0) throw new Error('Ratios must sum to more than 0');

    let remainder = this.amount;
    const results: Money[] = [];

    for (let i = 0; i < ratios.length; i++) {
      const share = Math.floor((this.amount * ratios[i]) / total);
      results.push(new Money(share, this.currency));
      remainder -= share;
    }

    // Distribute remainder (largest remainder method)
    for (let i = 0; i < remainder; i++) {
      results[i] = new Money(results[i].amount + 1, this.currency);
    }

    return results;
  }

  /**
   * Split equally among n recipients
   */
  split(parts: number): Money[] {
    return this.allocate(Array(parts).fill(1));
  }

  // ============ COMPARISON ============

  isZero(): boolean { return this.amount === 0; }
  isPositive(): boolean { return this.amount > 0; }
  isNegative(): boolean { return this.amount < 0; }
  
  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.greaterThan(other) || this.equals(other);
  }

  lessThanOrEqual(other: Money): boolean {
    return this.lessThan(other) || this.equals(other);
  }

  // ============ FORMATTING ============

  /**
   * Get amount in major unit (dollars, taka)
   */
  toUnit(): number {
    const config = CURRENCIES[this.currency] ?? { decimals: 2 };
    return this.amount / Math.pow(10, config.decimals);
  }

  /**
   * Format for display
   * @example Money.usd(1999).format() // "$19.99"
   */
  format(locale = 'en-US'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
    }).format(this.toUnit());
  }

  /**
   * Format without currency symbol
   */
  formatAmount(locale = 'en-US'): string {
    const config = CURRENCIES[this.currency] ?? { decimals: 2 };
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: config.decimals,
      maximumFractionDigits: config.decimals,
    }).format(this.toUnit());
  }

  /**
   * Convert to JSON-serializable object
   */
  toJSON(): MoneyValue {
    return { amount: this.amount, currency: this.currency };
  }

  /**
   * Create from JSON
   */
  static fromJSON(json: MoneyValue): Money {
    return new Money(json.amount, json.currency);
  }

  toString(): string {
    return `${this.currency} ${this.amount}`;
  }

  // ============ HELPERS ============

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}. Convert first.`
      );
    }
  }
}

/**
 * Helper functions for legacy compatibility
 */
export function toSmallestUnit(amount: number, currency = 'USD'): number {
  return Money.of(amount, currency).amount;
}

export function fromSmallestUnit(amount: number, currency = 'USD'): number {
  return Money.cents(amount, currency).toUnit();
}

export default Money;

