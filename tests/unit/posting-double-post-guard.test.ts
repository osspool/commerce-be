/**
 * Double-post mutual-exclusion guard.
 *
 * When a host opts into auto-invoicing (`INVOICE_AUTO_PURCHASE` /
 * `INVOICE_AUTO_SALES`), the @classytic/invoice engine creates AND posts the
 * AR/AP document from the SAME commerce event the direct posting handlers
 * subscribe to. Without a guard, A/P (purchase) or revenue (credit sale) would
 * be posted twice — once by the direct handler, once by the invoice engine —
 * with different idempotency keys, so the posting-service dedup can't catch it.
 *
 * The fix: the direct handler yields (returns null) when the invoice engine is
 * the document of record. This test pins the purchase path, whose guard runs
 * before any DB access. Env is set before a dynamic import so `config` parses
 * with the flag on (vitest isolates the module registry per file).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

describe('double-post guard — invoice engine vs direct posting', () => {
  it('purchase-received YIELDS to the invoice engine when INVOICE_AUTO_PURCHASE is on', async () => {
    // Reset first so `#config` re-parses env in THIS test (other files that ran
    // in the same worker may have cached config with the flag off).
    vi.resetModules();
    process.env.INVOICE_AUTO_PURCHASE = 'on_receive';
    const { purchaseReceivedHandler } = await import(
      '../../src/resources/accounting/events/handlers/purchase-received.handler.js'
    );
    const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Parameters<
      typeof purchaseReceivedHandler.build
    >[1];

    const work = await purchaseReceivedHandler.build(
      { purchaseId: '6a41a2766debf34845fc7127', organizationId: 'org-1' } as never,
      log,
    );

    // null = no direct A/P accrual; the invoice engine's auto-bill is the
    // single source of truth for this purchase. No double A/P.
    expect(work).toBeNull();
    expect(vi.mocked(log.debug)).toHaveBeenCalled();
    delete process.env.INVOICE_AUTO_PURCHASE;
  });
});

/**
 * Single-source-of-truth invariant (generalised from the guard above).
 *
 * Any event that BOTH a direct posting handler and the invoice engine's
 * auto-handler subscribe to is a double-post hazard. The contract is: the
 * direct handler must yield (read its `config.invoice.*` flag and `return null`)
 * when auto-invoicing owns that case. This locks the guard in place — if a
 * future edit removes it, this fails, not a customer's books.
 *
 * Source-level assertion is deliberate: the order-paid guard needs DB context
 * to reach behaviourally, so we pin the invariant structurally for both the
 * order (credit-sale) and purchase paths. Add a row here whenever you wire a
 * new auto-invoice case in invoice.events.ts.
 */
const HANDLERS = join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'src/resources/accounting/events/handlers',
);

const DUAL_PATH = [
  { economic: 'vendor bill A/P', file: 'purchase-received.handler.ts', flag: 'autoPurchase' },
  { economic: 'credit-sale revenue/A-R', file: 'order-paid.handler.ts', flag: 'autoSales' },
] as const;

describe('posting single-source-of-truth invariant', () => {
  it.each(DUAL_PATH)(
    'direct handler for $economic yields to the invoice engine (config.invoice.$flag guard present)',
    ({ file, flag }) => {
      const src = readFileSync(join(HANDLERS, file), 'utf8');
      expect(src, `${file} must read config.invoice.${flag}`).toContain(`config.invoice.${flag}`);
      expect(src, `${file} must early-return (yield) when the invoice engine owns the case`).toMatch(
        /return null/,
      );
    },
  );
});
