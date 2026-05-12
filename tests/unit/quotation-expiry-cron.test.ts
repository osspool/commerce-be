/**
 * Quotation expiry cron — unit test (MAJOR gap)
 *
 * Gap: QuotationRepository.expireDue() exists but no cron wires it —
 *      expired quotations are never auto-transitioned.
 *
 * Fix: 'quotation.expiry' cron job added to cron/index.ts calling
 *      orderEngine.repositories.quotation.expireDue(now, ctx).
 *
 * RED: quotation.expiry job absent from cron registry
 * GREEN: job present with correct name and hourly interval
 */

import { describe, it, expect } from 'vitest';

describe('Quotation expiry cron entry', () => {
  it('cron/index.ts contains quotation.expiry job', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('src/cron/index.ts', 'utf8');
    expect(src).toContain("name: 'quotation.expiry'");
    expect(src).toContain('expireDue');
  });

  it('quotation.expiry uses ONE_HOUR interval', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('src/cron/index.ts', 'utf8');
    // Job should appear before cart.checkout.sweep (ONE_DAY)
    const expiryIdx = src.indexOf("'quotation.expiry'");
    const cartIdx = src.indexOf("'cart.checkout.sweep'");
    expect(expiryIdx).toBeGreaterThan(0);
    expect(expiryIdx).toBeLessThan(cartIdx);
  });

  it('quotation.expiry passes actorKind: cron context', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('src/cron/index.ts', 'utf8');
    // The block around quotation.expiry should include cron actorKind
    const block = src.slice(src.indexOf("'quotation.expiry'"), src.indexOf("'cart.checkout.sweep'"));
    expect(block).toContain("actorKind: 'cron'");
  });
});
