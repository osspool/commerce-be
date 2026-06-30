/**
 * be-prod money authority — single-currency, config-driven.
 *
 * be-prod is a single-tenant deployment with ONE functional currency. That
 * currency is a deployment-level config (`BASE_CURRENCY` env, default `BDT`),
 * NOT a hardcoded constant — so forking the platform for a non-BD client is a
 * config flip, not a code change. The worldwide / multi-currency machinery
 * (per-currency minor-unit factors: BDT=100, JPY=1, KWD=1000, FX snapshots)
 * lives in `@classytic/primitives`; this module simply pins it to the
 * deployment's currency and exposes the two boundary conversions the app needs.
 *
 * Canonical (currency-neutral) names: `majorToMinor` / `minorToMajor`.
 * BDT-flavoured aliases (`takaToPaisa` / `paisaToTaka`) are kept so BD call
 * sites read naturally — both go through the same currency-aware primitive.
 *
 * Internally everything is integer minor units. `minorUnitFactor(BASE_CURRENCY)`
 * supplies the scale, so this is behaviour-identical to the old hand-rolled
 * `* 100` for BDT, and correct for any other configured currency.
 */
import { fromMajor, toMajor, type Money } from '@classytic/primitives/money';

/**
 * Functional currency of THIS deployment. Sourced from the `BASE_CURRENCY` env
 * (default `BDT`). Single-tenant → one currency per deployment. Must match
 * `PlatformConfig.baseCurrency`; {@link assertCurrencyConfig} verifies that at
 * boot so the books currency and the math currency can never silently diverge.
 */
export const BASE_CURRENCY = (process.env.BASE_CURRENCY ?? 'BDT').toUpperCase();

/**
 * Major units (possibly fractional, from a form / API boundary) → integer
 * minor units. Currency-aware via the primitive's `minorUnitFactor`. Throws on
 * a non-finite input — callers at untrusted boundaries should normalise first.
 */
export function majorToMinor(major: number): number {
  return fromMajor(major, BASE_CURRENCY).amount;
}

/** Integer minor units → major units (float, for display / wire boundaries). */
export function minorToMajor(minor: number): number {
  return toMajor({ amount: minor, currency: BASE_CURRENCY } as Money);
}

/**
 * Boot-time guard: the deployment's configured books currency
 * (`PlatformConfig.baseCurrency`) MUST equal the math currency
 * (`BASE_CURRENCY`). Call once at startup. Returns the mismatch (or null when
 * aligned) so the caller decides whether to warn or hard-fail.
 */
export function assertCurrencyConfig(
  platformBaseCurrency: string | undefined,
): { ok: true } | { ok: false; expected: string; got: string } {
  if (!platformBaseCurrency) return { ok: true };
  const got = platformBaseCurrency.toUpperCase();
  return got === BASE_CURRENCY ? { ok: true } : { ok: false, expected: BASE_CURRENCY, got };
}

// ── BDT-flavoured aliases (read naturally at BD call sites) ────────────────
/** Major taka → integer paisa. Alias of {@link majorToMinor}. */
export const takaToPaisa = majorToMinor;
/** Integer paisa → major taka. Alias of {@link minorToMajor}. */
export const paisaToTaka = minorToMajor;
