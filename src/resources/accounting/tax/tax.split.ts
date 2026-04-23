/**
 * Tax split helpers — compute net, VAT, and SD components from a gross amount.
 *
 * Callers pass in amounts (paisa) and rate metadata; this module returns
 * posting-ready components. Keeps tax math out of the posting contracts.
 *
 * Calculation order (NBR-mandated):
 *   1. Base Amount = (unitPrice - discount) × quantity
 *   2. SD Amount = base × sdRate / 100
 *   3. VAT Base = base + SD
 *   4. VAT Amount = vatBase × vatRate / 100
 *
 * Everything is integer paisa; never use float for money.
 */

export interface TaxSplit {
  /** Net taxable base (before SD, before VAT). */
  netAmount: number;
  /** Supplementary duty (0 if sdRate absent). */
  sdAmount: number;
  /** VAT (always on base + SD — tax on tax). */
  vatAmount: number;
  /** Gross: net + SD + VAT. */
  grandTotal: number;
  /** Echo of the rate used (for posting labels). */
  vatRate: number;
  /** Rate code, if supplied — drives account selection downstream. */
  vatRateCode?: string;
}

export interface SplitExclusiveInput {
  /** Net taxable amount in paisa (excludes VAT). */
  netAmount: number;
  /** VAT rate as a percentage (15 for 15%, 7.5 for 7.5%). */
  vatRate: number;
  /** Rate code for account selection (STANDARD, REDUCED_7_5, etc). */
  vatRateCode?: string;
  /** Supplementary duty rate (percentage). */
  sdRate?: number;
}

export interface SplitInclusiveInput {
  /** Gross amount that ALREADY INCLUDES VAT and SD (B2C retail pricing). */
  grandTotal: number;
  vatRate: number;
  vatRateCode?: string;
  sdRate?: number;
}

/** Round to nearest paisa (integer). */
function roundPaisa(value: number): number {
  return Math.round(value);
}

/**
 * Split a tax-exclusive amount into its components.
 * Use when netAmount is known and you need to add SD + VAT on top.
 */
export function splitExclusive(input: SplitExclusiveInput): TaxSplit {
  const net = roundPaisa(input.netAmount);
  const sdRate = input.sdRate ?? 0;
  const sdAmount = sdRate > 0 ? roundPaisa((net * sdRate) / 100) : 0;
  const vatBase = net + sdAmount;
  const vatAmount = input.vatRate > 0 ? roundPaisa((vatBase * input.vatRate) / 100) : 0;
  return {
    netAmount: net,
    sdAmount,
    vatAmount,
    grandTotal: net + sdAmount + vatAmount,
    vatRate: input.vatRate,
    vatRateCode: input.vatRateCode,
  };
}

/**
 * Split a tax-inclusive amount into its components.
 * Use for B2C retail where shelf price is the gross amount.
 *
 * Back-calc formula:
 *   combined = (1 + sd/100) × (1 + vat/100)
 *   net      = grand / combined
 *   sd       = net × sd/100
 *   vat      = grand - net - sd
 */
export function splitInclusive(input: SplitInclusiveInput): TaxSplit {
  const grand = roundPaisa(input.grandTotal);
  const sdRate = input.sdRate ?? 0;
  const vatRate = input.vatRate;
  const combined = (1 + sdRate / 100) * (1 + vatRate / 100);
  const net = roundPaisa(grand / combined);
  const sdAmount = sdRate > 0 ? roundPaisa((net * sdRate) / 100) : 0;
  const vatAmount = grand - net - sdAmount;
  return {
    netAmount: net,
    sdAmount,
    vatAmount,
    grandTotal: grand,
    vatRate,
    vatRateCode: input.vatRateCode,
  };
}

/**
 * Resolve a rate code from a numeric rate — used when upstream data only
 * carries a number (legacy purchases) and we need an account code.
 */
export function rateCodeForRate(rate: number): string {
  if (rate === 15) return 'STANDARD';
  if (rate === 10) return 'REDUCED_10';
  if (rate === 7.5) return 'REDUCED_7_5';
  if (rate === 5) return 'REDUCED_5';
  if (rate === 0) return 'ZERO';
  // Fallback: unknown rate maps to STANDARD account (parent)
  return 'STANDARD';
}
