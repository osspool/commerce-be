/**
 * Blanket order commitment-guard logic — unit test.
 *
 * Contract (since @classytic/order 0.2.0): on each release, the kernel
 * sizes the Order against the remaining commitment using SAP/Oracle
 * blanket-release semantics:
 *
 *   - No cap → release the template as-is.
 *   - requested < remaining → release full template, blanket stays active.
 *   - requested === remaining → release full template, blanket exhausts.
 *   - 0 < remaining < requested → PARTIAL FILL: clamp release to `remaining`
 *     so consumedQty lands exactly on cap, then exhaust.
 *   - remaining <= 0 → refuse — no Order created, blanket exhausts.
 *
 * `consumedQty` must never exceed `totalCommitmentQty`.
 */

import { describe, it, expect } from 'vitest';

type ClampResult = {
  generationQty: number;
  willExhaust: boolean;
  refused: boolean;
};

/**
 * Pure mirror of the sizing decision in `_generateFor`. Isolated for fast
 * unit testing without spinning up an order engine.
 */
function sizeRelease(
  consumed: number,
  requested: number,
  cap: number | undefined,
): ClampResult {
  if (cap === undefined) {
    return { generationQty: requested, willExhaust: false, refused: false };
  }
  const remaining = cap - consumed;
  if (remaining <= 0) {
    return { generationQty: 0, willExhaust: true, refused: true };
  }
  if (requested > remaining) {
    return { generationQty: remaining, willExhaust: true, refused: false };
  }
  if (requested === remaining) {
    return { generationQty: requested, willExhaust: true, refused: false };
  }
  return { generationQty: requested, willExhaust: false, refused: false };
}

describe('Blanket order release sizing — partial-fill semantics', () => {
  it('no cap → full release, never exhausts', () => {
    expect(sizeRelease(100, 50, undefined)).toEqual({
      generationQty: 50,
      willExhaust: false,
      refused: false,
    });
  });

  it('plenty of headroom → full release, blanket stays active', () => {
    expect(sizeRelease(0, 2, 5)).toEqual({
      generationQty: 2,
      willExhaust: false,
      refused: false,
    });
  });

  it('exact fit (requested === remaining) → full release, exhaust', () => {
    expect(sizeRelease(2, 3, 5)).toEqual({
      generationQty: 3,
      willExhaust: true,
      refused: false,
    });
  });

  it('partial fill (consumed=4, requested=3, cap=5) → clamp to 1, exhaust', () => {
    expect(sizeRelease(4, 3, 5)).toEqual({
      generationQty: 1,
      willExhaust: true,
      refused: false,
    });
  });

  it('partial fill never overdraws — consumedQty lands exactly on cap', () => {
    const { generationQty } = sizeRelease(60, 60, 100);
    expect(60 + generationQty).toBe(100);
  });

  it('already at cap → refuse, no order, exhaust', () => {
    expect(sizeRelease(5, 1, 5)).toEqual({
      generationQty: 0,
      willExhaust: true,
      refused: true,
    });
  });

  it('already past cap (defensive) → refuse, no order, exhaust', () => {
    expect(sizeRelease(7, 1, 5)).toEqual({
      generationQty: 0,
      willExhaust: true,
      refused: true,
    });
  });

  it('package source implements partial-fill (not the legacy hard-block guard)', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const repoFile = path.resolve(
      import.meta.dirname,
      '../../../packages/order/src/repositories/blanket-order.repository.ts',
    );
    const src = await fs.readFile(repoFile, 'utf8');
    // New partial-fill markers.
    expect(src).toContain('linesForOrder');
    expect(src).toContain('remaining - assigned');
    // Legacy guard strings must NOT appear.
    expect(src).not.toContain('blanket.consumedQty >= (blanket.totalCommitmentQty');
    expect(src).not.toContain('projectedConsumed > (blanket.totalCommitmentQty');
  });
});
