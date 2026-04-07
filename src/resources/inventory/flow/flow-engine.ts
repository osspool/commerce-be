/**
 * Flow Engine Singleton
 *
 * Creates and manages the @classytic/flow engine instance.
 * Initialized once at app startup via initializeFlowEngine().
 */
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { createFlowEngine } from '@classytic/flow';
import type { FlowEngine } from '@classytic/flow';
import config from '../../../config/index.js';
import catalogBridge from './catalog-bridge.js';
import { bridgeFlowEvents } from './arc-event-adapter.js';

let engine: FlowEngine | null = null;

export interface FlowEngineOptions {
  connection?: Connection;
  /** Suppress mongokit pagination index warnings. Default: true in production. */
  silent?: boolean;
}

/**
 * Initialize the Flow engine. Call once at app startup after mongoose is connected.
 */
export function initializeFlowEngine(options: FlowEngineOptions = {}): FlowEngine {
  if (engine) return engine;

  const { connection, silent = process.env.NODE_ENV === 'production' } = options;

  engine = createFlowEngine({
    mongoose: connection ?? mongoose.connection,
    mode: config.inventory.flowMode,
    catalog: catalogBridge,
    silent,
    // Align Flow's virtual locations with be-prod's seeded location conventions.
    // be-prod seeds 'adjustment' per branch; Flow defaults to 'inventory_loss'.
    virtualLocations: { adjustment: 'adjustment' },
  });

  // Bridge Flow events → Arc events
  bridgeFlowEvents(engine);

  return engine;
}

/**
 * Get the Flow engine instance.
 * Throws if not initialized (call initializeFlowEngine first).
 */
export function getFlowEngine(): FlowEngine {
  if (!engine) {
    throw new Error('FlowEngine not initialized. Call initializeFlowEngine() first.');
  }
  return engine;
}

/**
 * Get the Flow engine, or null if not yet initialized.
 * Useful for optional/lazy access patterns.
 */
export function getFlowEngineOrNull(): FlowEngine | null {
  return engine;
}

/**
 * Gracefully shut down the Flow engine. Call on app shutdown (e.g. SIGTERM).
 * Releases Flow-owned resources but does NOT close the Mongoose connection
 * (the app's db.plugin.ts owns that lifecycle via mongoose.disconnect()).
 */
export async function destroyFlowEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
  }
}
