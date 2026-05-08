/**
 * RMA Engine Singleton
 *
 * Creates and lazily-initializes the RmaRepository from the order engine's
 * Rma model. The repository is NOT part of OrderRepositories (the kernel
 * ships it as a standalone class), so we instantiate it here and share it
 * across the rma resource, actions, and lifecycle handlers.
 *
 * Tenant scoping: Arc's `orgScoped` preset enforces organizationId at the
 * query layer (same as every other order resource). `enabled: false` tells
 * the repository not to auto-inject the tenant filter — Arc owns that.
 */

import { RmaRepository } from '@classytic/order';
import type { EventTransport, RmaDocument } from '@classytic/order';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import mongoose, { type Model } from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';

const TENANT: ResolvedTenantConfig = {
  strategy: 'none',
  enabled: false,
  tenantField: 'organizationId',
  fieldType: 'objectId',
  ref: 'organization',
  contextKey: 'organizationId',
  required: false,
};

let rmaRepo: RmaRepository | null = null;

export async function ensureRmaRepository(): Promise<RmaRepository> {
  if (rmaRepo) return rmaRepo;
  const orderEngine = await ensureOrderEngine();
  // engine.models (OrderModels) omits Rma, but createOrder calls createOrderModels
  // which registers all OrderModelBundle models in mongoose.models — including Rma.
  const rmaModel = mongoose.models['Rma'] as Model<RmaDocument> | undefined;
  if (!rmaModel) throw new Error('Rma model not found — createOrder must register it via createOrderModels');
  rmaRepo = new RmaRepository({
    model: rmaModel,
    tenant: TENANT,
    idPrefix: 'RMA',
    idPartition: 'yearly',
    eventRepo: orderEngine.repositories.orderEvent as never,
    eventTransport: eventTransport as unknown as EventTransport,
  });
  return rmaRepo;
}

/** Test-only — reset between engine teardowns. */
export function destroyRmaRepository(): void {
  rmaRepo = null;
}
