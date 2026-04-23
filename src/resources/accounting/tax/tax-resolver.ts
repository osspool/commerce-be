/**
 * TaxResolver Contract — the consumer-owned interface every country tax
 * pack plugs into.
 *
 * Lives HERE in be-prod (the consumer), not in a shared abstraction package.
 * Country packs (@classytic/bd-tax, future in-vat, eu-vat) export plain
 * factory functions that structurally satisfy this shape — TypeScript's
 * structural typing checks the fit at the wire-up line. Same pattern as
 * every @classytic/* repository extending mongokit's `Repository<TDoc>`
 * without a shared abstraction package.
 *
 * If the contract ever evolves: bump this file, let the compiler surface
 * every country pack that no longer fits, ship coordinated minor bumps.
 */

// ── Country-neutral shape returned by `resolveClass` ────────────────────────

export interface TaxClassRate {
  /** Country-defined rate code — 'STANDARD' in BD, 'GST_18' in IN, etc. */
  rateCode: string;
  /** Percentage rate (0 for ZERO and EXEMPT) */
  rate: number;
  /** Whether this class allows input credit on purchases */
  inputCreditAllowed: boolean;
  /** Grid line for the country's monthly-return form (if any) */
  mushakGridOutput?: number;
  /** Additional audit metadata — country-specific */
  meta?: Record<string, unknown>;
}

// ── Fiscal-position result carries audit trail ──────────────────────────────

export interface FiscalPositionResult {
  position: string;
  /** SRO / certificate / export manifest reference — empty only for defaults */
  reference?: string;
  /** Human-readable explanation for the audit log */
  reason: string;
  /** Remap a product's tax class to the effective class for this transaction */
  mapTaxClass: (productClass: string) => string;
}

// ── Posting direction for account lookup ────────────────────────────────────

export type PostingDirection = 'input' | 'output';

// ── Regimes the accounting engine understands ───────────────────────────────

export type AccountingRegime = 'standard' | 'tot' | 'exempt' | 'importer' | 'rmg' | 'it' | 'service';

// ── The contract itself ─────────────────────────────────────────────────────

export interface TaxResolver {
  /** ISO-ish country code — 'BD', 'IN', 'EU-DE', etc. */
  readonly countryCode: string;

  /** Resolve a country-neutral tax class to its rate metadata. */
  resolveClass(taxClass: string, asOf?: Date): TaxClassRate | null;

  /** Enumerate every known tax class (for UI dropdowns / validation). */
  listClasses(): readonly string[];

  /** Determine the effective fiscal position for a buyer/seller pair. */
  resolveFiscalPosition?(
    buyer: Record<string, unknown>,
    seller: Record<string, unknown>,
    asOf?: Date,
  ): FiscalPositionResult;

  /**
   * Map a rate code + direction + regime to a chart-of-accounts GL code.
   * Returns `null` when no posting is required (e.g. exempt output, truncated
   * input without credit, cottage regime).
   */
  accountFor?(rateCode: string, direction: PostingDirection, regime: AccountingRegime, asOf?: Date): string | null;
}

// ── Additive runtime extension ──────────────────────────────────────────────

export interface ExtraTaxClassEntry {
  /** Class identifier (must be unique against the base resolver's list) */
  code: string;
  /** The rate metadata to return for this class */
  rate: TaxClassRate;
}

/**
 * Merge a base resolver with runtime-additive classes — lets a specific
 * deployment add deployment-specific codes (e.g. an SRO-covered custom NGO
 * class) without patching the country pack.
 *
 * Precedence: extras win over base when codes collide, so deployments can
 * also override base rates within their own scope if a future FY change
 * lands before the country pack is bumped.
 */
export function mergeResolvers(base: TaxResolver, extras: ExtraTaxClassEntry[]): TaxResolver {
  if (!extras.length) return base;
  const extraMap = new Map(extras.map((e) => [e.code, e.rate]));
  const mergedList = Array.from(new Set([...base.listClasses(), ...extraMap.keys()]));

  return {
    countryCode: base.countryCode,
    resolveClass(taxClass, asOf) {
      if (extraMap.has(taxClass)) return extraMap.get(taxClass)!;
      return base.resolveClass(taxClass, asOf);
    },
    listClasses: () => mergedList,
    resolveFiscalPosition: base.resolveFiscalPosition?.bind(base),
    accountFor: base.accountFor?.bind(base),
  };
}

/** Test helper — a no-op resolver for unit tests that don't need tax. */
export function createNullResolver(countryCode = 'TEST'): TaxResolver {
  return {
    countryCode,
    resolveClass: () => null,
    listClasses: () => [],
  };
}
