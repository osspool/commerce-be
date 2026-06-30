/**
 * #shared/money — config-driven base currency.
 *
 * The deployment currency comes from `BASE_CURRENCY` (env, default BDT), read
 * once at module load. We re-evaluate the module per case via `vi.resetModules`
 * + env, proving the SAME code is correct for BDT (2dp), JPY (0dp), KWD (3dp) —
 * i.e. a non-BD fork flips config, not code. The conversions are currency-aware
 * via `@classytic/primitives` `minorUnitFactor`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMoney(currency?: string) {
  vi.resetModules();
  if (currency) process.env.BASE_CURRENCY = currency;
  else delete process.env.BASE_CURRENCY;
  return import('../../src/shared/money.js');
}

afterEach(() => {
  delete process.env.BASE_CURRENCY;
});

describe('config-driven money', () => {
  it('defaults to BDT (factor 100) — behaviour-identical to the old hardcoded ×100', async () => {
    const m = await loadMoney();
    expect(m.BASE_CURRENCY).toBe('BDT');
    expect(m.majorToMinor(10)).toBe(1000);
    expect(m.minorToMajor(1000)).toBe(10);
    expect(m.takaToPaisa(2.5)).toBe(250); // alias still works
    expect(m.paisaToTaka(250)).toBe(2.5);
  });

  it('JPY → factor 1 (zero-decimal): no spurious ×100', async () => {
    const m = await loadMoney('JPY');
    expect(m.BASE_CURRENCY).toBe('JPY');
    expect(m.majorToMinor(1500)).toBe(1500);
    expect(m.minorToMajor(1500)).toBe(1500);
  });

  it('KWD → factor 1000 (three-decimal)', async () => {
    const m = await loadMoney('KWD');
    expect(m.majorToMinor(1)).toBe(1000);
    expect(m.minorToMajor(1000)).toBe(1);
  });

  it('lowercase env is normalised', async () => {
    const m = await loadMoney('usd');
    expect(m.BASE_CURRENCY).toBe('USD');
  });

  it('assertCurrencyConfig catches a books-vs-math currency mismatch', async () => {
    const m = await loadMoney('USD');
    expect(m.assertCurrencyConfig('USD')).toEqual({ ok: true });
    expect(m.assertCurrencyConfig('usd')).toEqual({ ok: true });
    expect(m.assertCurrencyConfig(undefined)).toEqual({ ok: true });
    expect(m.assertCurrencyConfig('BDT')).toEqual({ ok: false, expected: 'USD', got: 'BDT' });
  });
});
