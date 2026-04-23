/**
 * Flow Engine Singleton
 *
 * Creates and manages the @classytic/flow engine instance.
 * Initialized once at app startup via initializeFlowEngine().
 *
 * v4: Scope strategy is explicit (organizationId = branchId).
 *     Enterprise services (quality, task, dispatch, rfid) are
 *     only instantiated when mode = 'enterprise'.
 */

import type { EventTransport, FlowEngine } from '@classytic/flow';
import { createFlowEngine, ensureFlowReady } from '@classytic/flow';
import type { Connection } from 'mongoose';
import mongoose from 'mongoose';
import config from '#config/index.js';
import { eventTransport } from '#lib/events/EventBus.js';
import catalogBridge from './catalog-bridge.js';
import { CounterDeviceSequenceStore } from './counter-device-store.js';

let engine: FlowEngine | null = null;
let readyPromise: Promise<void> | null = null;

export interface FlowEngineOptions {
  connection?: Connection;
  silent?: boolean;
}

export function initializeFlowEngine(options: FlowEngineOptions = {}): FlowEngine {
  if (engine) return engine;

  const { connection, silent = process.env.NODE_ENV === 'production' } = options;

  // Lazy Counter-backed store for offline sync persistence (enterprise only)
  const deviceSequenceStore =
    config.inventory.flowMode === 'enterprise'
      ? new CounterDeviceSequenceStore(() => engine?.models?.Counter ?? null)
      : undefined;

  engine = createFlowEngine({
    mongoose: connection ?? mongoose.connection,
    mode: config.inventory.flowMode,
    catalog: catalogBridge,
    silent,

    // Scope: organizationId = branchId (Better Auth org).
    scope: {
      strategy: 'field',
      tenantField: 'organizationId',
      required: true,
    },

    // Inventory valuation: drives cost layer consumption on stock issuance.
    // FIFO = drain oldest cost layers first (IAS 2 compliant).
    // WAC = use weighted average from quant.unitCost (no layer drain).
    // FEFO = drain nearest-expiry first (perishables).
    valuation: { method: config.inventory.valuationMethod },

    // Align Flow's virtual locations with be-prod's seeded location conventions.
    virtualLocations: { adjustment: 'adjustment' },

    // Persistent device sequence tracking (enterprise offline sync)
    deviceSequenceStore,

    // Share Arc's event transport directly — Arc's MemoryEventTransport
    // structurally satisfies Flow's EventTransport, so flow events land
    // on the same bus as Arc CRUD events. No bridge adapter needed.
    // Swap to RedisEventTransport / Kafka / etc. when scaling out.
    eventTransport: eventTransport as unknown as EventTransport,
  });

  // Kick off the one-time collection + index materialisation. Consumers
  // that need the engine to be fully ready (tests, transactional request
  // handlers) should `await ensureFlowEngineReady()` before first use.
  // Doing it lazily here keeps `initializeFlowEngine()` synchronous for
  // callers that don't need the guarantee.
  readyPromise = ensureFlowReady(engine, { skipIndexes: config.isProduction }).catch((err) => {
    readyPromise = null;
    throw err;
  });

  return engine;
}

/**
 * Awaits the one-time collection + index materialisation kicked off by
 * `initializeFlowEngine()`. Safe to call multiple times — resolves
 * immediately if the setup has already completed.
 *
 * Call this:
 *   - inside the Fastify plugin `onReady` hook (so HTTP requests never
 *     race the background index build)
 *   - in every integration test's `beforeAll` (so transactional service
 *     calls don't trip on a catalog-change error)
 */
export async function ensureFlowEngineReady(): Promise<void> {
  if (!engine) {
    throw new Error('FlowEngine not initialized. Call initializeFlowEngine() before ensureFlowEngineReady().');
  }
  if (!readyPromise) {
    readyPromise = ensureFlowReady(engine);
  }
  await readyPromise;
}

export function getFlowEngine(): FlowEngine {
  if (!engine) {
    throw new Error('FlowEngine not initialized. Call initializeFlowEngine() first.');
  }
  return engine;
}

export function getFlowEngineOrNull(): FlowEngine | null {
  return engine;
}

export async function destroyFlowEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
    readyPromise = null;
  }
}
