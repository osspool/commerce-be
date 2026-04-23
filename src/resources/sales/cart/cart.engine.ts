/**
 * Cart engine singleton — initialized by cart.plugin.ts via bootstrap[].
 *
 * Shares Arc's event transport directly — Arc's MemoryEventTransport
 * structurally satisfies primitives' EventTransport, so cart events
 * land on the same bus as Arc CRUD events. No bridge adapter needed.
 */

import { type CartEngine, cartEventDefinitions, createCart, skuKind, variantKind } from '@classytic/cart';
import type { EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';
import { eventRegistry } from '#shared/event-registry.js';
import { outboxStore } from '#shared/outbox/index.js';
import { catalogBridge } from './cart.bridges.js';

let _engine: CartEngine | null = null;

function registerCartEvents(): void {
  for (const definition of cartEventDefinitions) {
    if (!eventRegistry.get(definition.name, definition.version)) {
      eventRegistry.register(definition);
    }
  }
}

export async function initCartEngine(): Promise<CartEngine> {
  if (_engine) return _engine;
  registerCartEvents();
  _engine = await createCart({
    connection: mongoose.connection,
    autoIndex: process.env.NODE_ENV !== 'production',
    kinds: [skuKind, variantKind],
    bridges: { catalog: catalogBridge },
    defaultCurrency: process.env.DEFAULT_CURRENCY || 'BDT',
    // BigBoss is single-tenant multi-branch. Customer shopping carts are
    // company-wide — they follow the user across branches, so no tenant
    // scoping. POS doesn't use this package (its cart lives on the frontend).
    multiTenant: false,
    // Share Arc's event transport — same pattern as flow-engine.ts
    eventTransport: eventTransport as unknown as EventTransport,
    outbox: outboxStore,
  });
  return _engine;
}

export function getCartEngine(): CartEngine {
  if (!_engine) throw new Error('Cart engine not initialized — register cart.plugin.ts in bootstrap[]');
  return _engine;
}
