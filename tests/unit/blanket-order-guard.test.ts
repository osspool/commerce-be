/**
 * Blanket order quantity guard — unit test (MAJOR gap)
 *
 * Gap: No cumulative quantity guard — generation was blocked only when
 *      consumedQty >= totalCommitmentQty, not when projectedConsumed would exceed it.
 *      An order with consumedQty=4, cap=5, generationQty=3 would over-order by 2.
 *
 * Fix: Changed condition to `projectedConsumed > totalCommitmentQty` in
 *      packages/order/src/repositories/blanket-order.repository.ts
 *
 * RED: guard uses consumedQty >= cap (too late — already at cap)
 * GREEN: guard uses projectedConsumed > cap (blocks before over-order)
 */

import { describe, it, expect } from 'vitest';

describe('Blanket order quantity guard logic', () => {
  /**
   * Mirrors the _generateFor guard condition — isolated for fast unit testing
   * without needing a full order engine instance.
   */
  function wouldExceedCommitment(
    consumedQty: number,
    generationQty: number,
    totalCommitmentQty: number | undefined,
  ): boolean {
    if (totalCommitmentQty === undefined) return false;
    const projectedConsumed = (consumedQty ?? 0) + generationQty;
    return projectedConsumed > totalCommitmentQty;
  }

  it('blocks generation when projectedConsumed exceeds cap', () => {
    // consumedQty=4, cap=5, generationQty=3 → projected=7 > 5
    expect(wouldExceedCommitment(4, 3, 5)).toBe(true);
  });

  it('allows generation when projectedConsumed is exactly at cap', () => {
    // consumedQty=2, cap=5, generationQty=3 → projected=5, not > 5
    expect(wouldExceedCommitment(2, 3, 5)).toBe(false);
  });

  it('blocks when already at cap (edge case from old bug)', () => {
    // consumedQty=5, cap=5, generationQty=1 → projected=6 > 5
    expect(wouldExceedCommitment(5, 1, 5)).toBe(true);
  });

  it('allows when no cap is set', () => {
    expect(wouldExceedCommitment(100, 50, undefined)).toBe(false);
  });

  it('package source uses projectedConsumed not consumedQty in the guard', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const repoFile = path.resolve(
      import.meta.dirname,
      '../../../packages/order/src/repositories/blanket-order.repository.ts',
    );
    const src = await fs.readFile(repoFile, 'utf8');
    // The fixed condition must reference projectedConsumed, not the old consumedQty check
    expect(src).toContain('projectedConsumed > (blanket.totalCommitmentQty');
    // Old condition must NOT appear
    expect(src).not.toContain('blanket.consumedQty >= (blanket.totalCommitmentQty');
  });
});
