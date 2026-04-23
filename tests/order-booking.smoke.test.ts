/**
 * order-booking smoke test — catalog + order + Arc, end-to-end.
 *
 * Proves the full HTTP-in → event-out pipeline against a real boot:
 *
 *   1. `createApplication()` boots with resources loaded.
 *   2. The shared `eventRegistry` has ALL `orderEventDefinitions` and
 *      `catalogEventDefinitions` pre-registered (no drift at runtime).
 *   3. OpenAPI spec at `/_docs/openapi.json` surfaces the order-related
 *      routes the packages expose.
 *   4. The in-process event transport delivers `order:booking.*` events
 *      when a booking fulfillment domain verb runs.
 *   5. JSON-Schema validation on booking events succeeds for well-formed
 *      payloads and fails for malformed ones.
 *
 * This is deliberately a SMOKE test, not a scenario: it checks that the
 * plumbing is alive, not every domain branch. Scenario tests in the
 * `@classytic/order` package already cover business flows.
 *
 * Event registration happens at module-load time inside
 * `src/shared/event-registry.ts` — this test simply observes the
 * already-populated registry.
 *
 * Takes ~3-5s on a warm mongo-memory-server.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import {
  orderEventDefinitions,
  BookingCheckInEvent,
} from '@classytic/order';
import { catalogEventDefinitions } from '@classytic/catalog';
import { flowEventDefinitions } from '@classytic/flow';
import { invoiceEventDefinitions } from '@classytic/invoice';
import { ledgerEventDefinitions } from '@classytic/ledger';
import { loyaltyEventDefinitions } from '@classytic/loyalty';
import { promoEventDefinitions } from '@classytic/promo';
import { revenueEventDefinitions } from '@classytic/revenue';
import { eventRegistry } from '../src/shared/event-registry.js';
import { eventTransport } from '../src/lib/events/EventBus.js';

let app: FastifyInstance | undefined;

describe('order-booking smoke — catalog + order + Arc pipeline', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
    }

    // Seed PlatformConfig — loyalty plugin requires it during app boot.
    const PlatformConfig = mongoose.models.PlatformConfig;
    if (PlatformConfig) {
      await PlatformConfig.findOneAndUpdate(
        { isSingleton: true },
        { $set: { isSingleton: true, membership: { enabled: false } } },
        { upsert: true },
      );
    }

    const { loadTestResources } = await import('./setup/preload-resources.js');
    const { resources } = await loadTestResources();
    const { createApplication } = await import('../src/app.js');
    app = await createApplication({ resources });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // ─── 1. App boots ──────────────────────────────────────────────────────

  it('boots with order + catalog engines wired', () => {
    expect(app).toBeDefined();
  });

  // ─── 2. Event catalogs are pre-registered at boot ──────────────────────

  it('shared registry contains every commerce-package event (registered in event-registry.ts)', () => {
    const catalog = eventRegistry.catalog();
    const names = new Set(catalog.map((e) => e.name));

    // Every definition from the packages must be present in the merged catalog.
    for (const def of orderEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of catalogEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of flowEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of invoiceEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of ledgerEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of loyaltyEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of promoEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }
    for (const def of revenueEventDefinitions) {
      expect(names.has(def.name)).toBe(true);
    }

    // Namespace spot-checks across all eight packages.
    expect(names.has('order:booking.check_in')).toBe(true);
    expect(names.has('order:booking.no_show')).toBe(true);
    expect(names.has('catalog:offer.sold')).toBe(true);
    expect(names.has('catalog:product.created')).toBe(true);
    expect(names.has('flow.reservation.created')).toBe(true);
    expect(names.has('flow.move.done')).toBe(true);
    expect(names.has('flow.package.sealed')).toBe(true);
    expect(names.has('invoice:created')).toBe(true);
    expect(names.has('invoice:paid')).toBe(true);
    expect(names.has('ledger:entry.posted')).toBe(true);
    expect(names.has('ledger:reconciliation.matched')).toBe(true);
    expect(names.has('loyalty.points.earned')).toBe(true);
    expect(names.has('loyalty.tier.upgraded')).toBe(true);
    expect(names.has('promo.voucher.redeemed')).toBe(true);
    expect(names.has('promo.evaluation.committed')).toBe(true);
    expect(names.has('revenue:payment.verified')).toBe(true);
    expect(names.has('revenue:escrow.split')).toBe(true);
  });

  it('catalog entries carry JSON Schemas that Arc can introspect', () => {
    const catalog = eventRegistry.catalog();
    for (const entry of catalog.filter(
      (e) =>
        e.name.startsWith('order:') ||
        e.name.startsWith('catalog:') ||
        e.name.startsWith('flow.') ||
        e.name.startsWith('invoice:') ||
        e.name.startsWith('ledger:') ||
        e.name.startsWith('loyalty.') ||
        e.name.startsWith('promo.'),
    )) {
      if (!entry.schema) continue;
      expect(entry.schema).toMatchObject({ type: 'object' });
    }
  });

  // ─── 3. Arc EventRegistry enforces validation ──────────────────────────

  it('rejects a malformed BOOKING_CHECK_IN payload under Arc validation', () => {
    const result = eventRegistry.validate('order:booking.check_in', {
      // missing required fulfillmentNumber + checkedInAt
      orderNumber: 'BK-2026-04-0001',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a well-formed BOOKING_CHECK_IN payload under Arc validation', () => {
    const result = eventRegistry.validate('order:booking.check_in', {
      orderNumber: 'BK-2026-04-0001',
      fulfillmentNumber: 'BKF-2026-04-0001',
      checkedInAt: new Date().toISOString(),
    });
    expect(result.valid).toBe(true);
  });

  // ─── 3b. Arc eventPlugin.validateMode wires the pipeline end-to-end ────
  //
  // Publishing through `app.events.publish()` must:
  //   - succeed for a schema-valid payload
  //   - throw for a schema-invalid one (validateMode='reject' in test env)
  //
  // This proves the registry we populate in `shared/event-registry.ts` is
  // actually consulted on every publish, not just exposed via OpenAPI. If
  // an emit site drifts from the registered Zod schema, these tests fail
  // at PR time instead of silently corrupting subscribers at runtime.

  it('app.events.publish() succeeds for a schema-valid payload', async () => {
    expect(app).toBeDefined();
    const events = (app as unknown as { events?: { publish?: (...args: unknown[]) => Promise<void> } }).events;
    expect(typeof events?.publish).toBe('function');

    await expect(
      events!.publish!('order:booking.check_in', {
        orderNumber: 'BK-VALIDATE-OK',
        fulfillmentNumber: 'BKF-VALIDATE-OK',
        checkedInAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('app.events.publish() rejects a schema-invalid payload (validateMode=reject in tests)', async () => {
    expect(app).toBeDefined();
    const events = (app as unknown as { events: { publish: (...args: unknown[]) => Promise<void> } }).events;

    await expect(
      events.publish('order:booking.check_in', {
        // missing required fulfillmentNumber + checkedInAt
        orderNumber: 'BK-VALIDATE-FAIL',
      }),
    ).rejects.toThrow(/validation failed/i);
  });

  // ─── 4. OpenAPI spec surfaces order routes ─────────────────────────────

  it('OpenAPI spec is served at /_docs/openapi.json and includes order paths', async () => {
    expect(app).toBeDefined();
    const res = await app!.inject({ method: 'GET', url: '/_docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = JSON.parse(res.body);
    expect(spec.openapi).toBeDefined();
    expect(spec.paths).toBeDefined();

    // Order resource paths (be-prod's sales/orders resource mounts these).
    const pathKeys = Object.keys(spec.paths);
    const hasOrderRoute = pathKeys.some((p) => p.includes('/order'));
    expect(hasOrderRoute).toBe(true);
  });

  // ─── 5. Event transport delivers booking events in-process ─────────────

  it('delivers order:booking.* events through the shared event transport', async () => {
    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = await eventTransport.subscribe?.('order:booking.*', (event) => {
      received.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      });
    });

    // Directly publish a well-formed event via the definition's `.create()`
    // helper — same code path the package uses internally. This bypasses
    // the domain verb (which needs a real Mongo order + fulfillment doc)
    // and focuses the smoke test on pipeline proof.
    const event = BookingCheckInEvent.create(
      {
        orderNumber: 'BK-SMOKE-0001',
        fulfillmentNumber: 'BKF-SMOKE-0001',
        checkedInAt: new Date().toISOString(),
      },
      { organizationId: 'smoke', correlationId: 'smoke-1' },
    );
    await eventTransport.publish(event);

    // Memory transport is synchronous-on-publish; a micro-tick suffices.
    await new Promise((r) => setTimeout(r, 20));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.type).toBe('order:booking.check_in');
    expect(received[0]?.payload.orderNumber).toBe('BK-SMOKE-0001');

    if (unsubscribe) unsubscribe();
  });

  // ─── 6. Event registry catalog introspection ───────────────────────────

  it('event registry `.catalog()` exposes every commerce-package event', () => {
    const catalog = eventRegistry.catalog();
    const total =
      orderEventDefinitions.length +
      catalogEventDefinitions.length +
      flowEventDefinitions.length +
      invoiceEventDefinitions.length +
      ledgerEventDefinitions.length +
      loyaltyEventDefinitions.length +
      promoEventDefinitions.length +
      revenueEventDefinitions.length;
    // be-prod may register additional events besides ours — assert floor, not equality.
    expect(catalog.length).toBeGreaterThanOrEqual(total);
  });
});
