/**
 * Supplier Performance scorecard (T3.3) — full lifecycle.
 *
 * Acceptance criteria (from ERP_COMPLETENESS):
 *   1. Receive 10 POs from supplier A — 8 on time, 2 late by 3 days
 *   2. Compute scorecard → on-time rate 80%, average delay rolls up
 *   3. Defect events recorded → defect rate appears
 *   4. Score persists across compute calls (idempotent)
 *
 * Test calls the kernel service directly (skip HTTP boot — keeps the test
 * fast and isolates the scoring algorithm from auth + Arc plumbing). HTTP
 * routes are typecheck-locked; their behaviour is exercised separately
 * by sending a single POST per route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createSupplierPerformance,
  type SupplierPerformanceContext,
  type SupplierPerformanceEngine,
} from '@classytic/supplier-performance';

let mongo: MongoMemoryServer;
let engine: SupplierPerformanceEngine;
const ORG = '5f9d88e7c8b8f3a2c8b3a2c8'; // 24-char ObjectId hex
const SUPPLIER = 'SUP-A';

const ctx: SupplierPerformanceContext = {
  organizationId: ORG,
  actorRef: 'test-runner',
  actorKind: 'system',
  correlationId: 'test',
};

const PERIOD = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-05-01T00:00:00Z'),
  label: '2026-04',
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  engine = await createSupplierPerformance({
    connection: mongoose.connection,
    tenant: { fieldType: 'objectId' },
  });
  await engine.syncIndexes();
}, 90_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongo?.stop();
}, 30_000);

beforeEach(async () => {
  // Wipe collections between tests so each scenario gets a fresh state.
  await Promise.all([
    engine.models.PerformanceEvent.deleteMany({}),
    engine.models.SupplierScore.deleteMany({}),
  ]);
});

describe('Supplier Performance scorecard (T3.3)', () => {
  it('aggregates 10 PO receipts (8 on-time + 2 late) into 80% on-time + avg delay', async () => {
    // 8 on-time: each delivers 100 units
    for (let i = 0; i < 8; i++) {
      await engine.services.score.recordEvent(
        {
          supplierId: SUPPLIER,
          type: 'delivery_received',
          occurredAt: new Date(`2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
          metrics: { quantity: 100 },
          sourceRef: `PO-OK-${i + 1}`,
        },
        ctx,
      );
    }
    // 2 late, 3 days each, 100 units each
    for (let i = 0; i < 2; i++) {
      await engine.services.score.recordEvent(
        {
          supplierId: SUPPLIER,
          type: 'delivery_late',
          occurredAt: new Date(`2026-04-${String(20 + i).padStart(2, '0')}T10:00:00Z`),
          metrics: { quantity: 100, delayDays: 3 },
          sourceRef: `PO-LATE-${i + 1}`,
        },
        ctx,
      );
    }

    const score = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );

    const m = score.metrics as Record<string, number>;
    expect(m.deliveryCount).toBe(10);
    expect(m.onTimeCount).toBe(8);
    expect(m.onTimeRate).toBe(0.8);
    // Avg delay across late deliveries (2 × 3 days / 2 late) = 3
    expect(m.avgDelayDays).toBe(3);
    // Units: 10 × 100
    expect(m.unitsReceived).toBe(1000);
    expect(score.eventCount).toBe(10);
    // Composite: 0.8 × 0.5 + 1 × 0.4 + 1 × 0.1 = 0.9 → 90
    expect(m.compositeScore).toBe(90);
  }, 30_000);

  it('records defect events and surfaces a defect rate on the scorecard', async () => {
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_received',
        occurredAt: new Date('2026-04-05T10:00:00Z'),
        metrics: { quantity: 100 },
        sourceRef: 'PO-1',
      },
      ctx,
    );
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'defect_reported',
        occurredAt: new Date('2026-04-08T10:00:00Z'),
        metrics: { quantity: 5 },
        sourceRef: 'RMA-1',
        sourceType: 'return',
      },
      ctx,
    );

    const score = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );
    const m = score.metrics as Record<string, number>;
    expect(m.defectiveUnits).toBe(5);
    expect(m.unitsReceived).toBe(100);
    expect(m.defectRate).toBe(0.05); // 5%
  }, 30_000);

  it('computeScore is idempotent — same period upserts in place', async () => {
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_received',
        occurredAt: new Date('2026-04-10T10:00:00Z'),
        metrics: { quantity: 50 },
        sourceRef: 'PO-X',
      },
      ctx,
    );

    const first = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );
    const second = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );

    expect(String(second._id)).toBe(String(first._id));
    expect(await engine.models.SupplierScore.countDocuments({ supplierId: SUPPLIER })).toBe(1);
    expect((second.metrics as Record<string, number>).deliveryCount).toBe(1);
  }, 30_000);

  it('price_variance events roll up to avgPriceVariance', async () => {
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'price_variance',
        occurredAt: new Date('2026-04-05T10:00:00Z'),
        metrics: { variancePct: 0.04, expectedUnitCost: 100, actualUnitCost: 104 },
        sourceRef: 'BILL-1',
      },
      ctx,
    );
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'price_variance',
        occurredAt: new Date('2026-04-12T10:00:00Z'),
        metrics: { variancePct: 0.08, expectedUnitCost: 50, actualUnitCost: 54 },
        sourceRef: 'BILL-2',
      },
      ctx,
    );

    const score = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );
    const m = score.metrics as Record<string, number>;
    expect(m.priceVarianceCount).toBe(2);
    expect(m.avgPriceVariance).toBe(0.06); // (0.04 + 0.08) / 2
  }, 30_000);

  it('events outside the period window are ignored', async () => {
    // Inside window
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_received',
        occurredAt: new Date('2026-04-15T10:00:00Z'),
        metrics: { quantity: 100 },
        sourceRef: 'PO-IN',
      },
      ctx,
    );
    // Outside (before)
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_late',
        occurredAt: new Date('2026-03-15T10:00:00Z'),
        metrics: { quantity: 999, delayDays: 30 },
        sourceRef: 'PO-OUT-PRE',
      },
      ctx,
    );
    // Outside (after — period.end is exclusive)
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_late',
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        metrics: { quantity: 999, delayDays: 30 },
        sourceRef: 'PO-OUT-POST',
      },
      ctx,
    );

    const score = await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );
    const m = score.metrics as Record<string, number>;
    expect(m.deliveryCount).toBe(1);
    expect(m.onTimeRate).toBe(1);
    expect(score.eventCount).toBe(1);
  }, 30_000);

  it('getScorecard with no period returns the latest persisted snapshot', async () => {
    await engine.services.score.recordEvent(
      {
        supplierId: SUPPLIER,
        type: 'delivery_received',
        occurredAt: new Date('2026-04-10T10:00:00Z'),
        metrics: { quantity: 50 },
        sourceRef: 'PO-A',
      },
      ctx,
    );
    await engine.services.score.computeScore(
      { supplierId: SUPPLIER, period: PERIOD },
      ctx,
    );

    const latest = await engine.services.score.getScorecard(SUPPLIER, ctx);
    expect(latest).not.toBeNull();
    expect(latest!.supplierId).toBe(SUPPLIER);
    expect((latest!.metrics as Record<string, number>).deliveryCount).toBe(1);
  }, 30_000);
});
