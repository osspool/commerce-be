/**
 * Supplier Performance Engine Singleton.
 *
 * Lazy-initializes `@classytic/supplier-performance` on the default
 * mongoose connection. Same pattern as catalog/order/flow engines.
 *
 * Shares Arc's event transport so kernel `supplier_performance:*` events
 * land on the same bus as everything else; that's also how the bridge
 * subscribers (`flow:procurement.received` → `recordEvent`) hear upstream
 * signals.
 */

import { createSupplierPerformance } from '@classytic/supplier-performance';
import type { SupplierPerformanceEngine } from '@classytic/supplier-performance';
import type { EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';

let engine: SupplierPerformanceEngine | null = null;
let pending: Promise<SupplierPerformanceEngine> | null = null;

export async function ensureSupplierPerformanceEngine(): Promise<SupplierPerformanceEngine> {
  if (engine) return engine;

  if (!pending) {
    pending = (async () => {
      engine = await createSupplierPerformance({
        connection: mongoose.connection,
        // Match other engines — Arc's preset is the tenant boundary, but
        // the schema still gets `organizationId` (string here, the default).
        tenant: { fieldType: 'objectId' },
        eventTransport: eventTransport as unknown as EventTransport,
      });
      await engine.syncIndexes();
      return engine;
    })();
  }
  return pending;
}

export function getSupplierPerformanceEngineOrNull(): SupplierPerformanceEngine | null {
  return engine;
}
