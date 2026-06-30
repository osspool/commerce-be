/**
 * Transfer Engine Singleton
 *
 * Wires @classytic/transfer with three be-prod bridges:
 *
 *   SequenceBridge — delegates to InventoryCounter, same as purchase engine.
 *                    Prefix: TRNS-YYYYMM-NNNN.
 *
 *   FlowBridge     — adapts the transfer kernel's stock-movement ports to
 *                    be-prod's Flow engine (getFlowEngine / buildFlowContext).
 *                    Implements:
 *                      checkAvailability      → flow.services.quant.getAvailability
 *                      createOutboundMoveGroup → MoveGroup shipment at sender
 *                      createInboundMoveGroup  → MoveGroup receipt at receiver
 *
 *   EventTransport — wraps arcEvents.publish (same pattern as purchase engine).
 *
 * Activation: call initializeTransferEngine() inside the Fastify plugin
 * onReady hook AFTER initializeFlowEngine() — the FlowBridge calls
 * getFlowEngine() at request time (lazy), so init order is safe as long as
 * both are initialized before the first HTTP request arrives.
 */

import { createTransferEngine, type TransferEngine } from '@classytic/transfer/engine';
import type { FlowBridge, SequenceBridge } from '@classytic/transfer/domain';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import { InventoryCounter } from '#resources/inventory/flow/counter-bridge.js';
import {
  buildFlowContext,
  CUSTOMER_LOCATION,
  VENDOR_LOCATION,
  skuRefFromProduct,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngine } from '#resources/inventory/flow/flow-engine.js';
import {
  createLocationCache,
  resolveLocationCode,
  LocationResolutionError,
} from '#resources/inventory/flow/location-resolver.js';
import { ensureBranchBootstrapped } from '#resources/inventory/inventory-management.plugin.js';
import { shouldAutoIndex } from '#shared/db/auto-index.js';

// ─── Singletons ────────────────────────────────────────────────────────────

let engine: TransferEngine | null = null;

// ─── Bridge: SequenceBridge ────────────────────────────────────────────────

const sequenceBridge: SequenceBridge = {
  async nextDocumentNumber(): Promise<string> {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const seq = await InventoryCounter.nextSeq('TRNS', ym);
    return `TRNS-${ym}-${String(seq).padStart(4, '0')}`;
  },
};

// ─── Bridge: FlowBridge ────────────────────────────────────────────────────

const flowBridge: FlowBridge = {
  /**
   * Check per-item availability at the sender branch before approval.
   * Interface: (items, senderBranchId, actorId?) → Promise<void>; throws if short.
   */
  async checkAvailability(
    items: Array<{
      product: string;
      variantSku?: string | null;
      quantity: number;
      sourceLocationId?: string;
    }>,
    senderBranchId: string,
    actorId?: string,
  ): Promise<void> {
    const flow = getFlowEngine();
    const senderCtx = buildFlowContext(senderBranchId, actorId ?? 'system');
    await ensureBranchBootstrapped(senderCtx.organizationId);

    const locationCache = createLocationCache();

    for (const item of items) {
      const skuRef = skuRefFromProduct(item.product, item.variantSku);
      let locationCode: string;
      try {
        locationCode = await resolveLocationCode(flow, item.sourceLocationId, senderCtx, {
          cache: locationCache,
        });
      } catch (err) {
        if (err instanceof LocationResolutionError) {
          throw new LocationResolutionError(`Location unavailable for SKU ${skuRef}: ${err.message}`, err.statusCode);
        }
        throw err;
      }

      const avail = await flow.services.quant.getAvailability(
        { skuRef, locationId: locationCode },
        senderCtx,
      );
      if ((avail.quantityAvailable ?? 0) < item.quantity) {
        throw new Error(
          `Insufficient stock for SKU ${skuRef}: available ${avail.quantityAvailable ?? 0}, requested ${item.quantity}`,
        );
      }
    }
  },

  /**
   * Create the outbound MoveGroup at the sender branch: stock → customer (transit).
   * Interface: (transferId, documentNumber, items, senderBranchId, receiverBranchId, actorId?) → Promise<string>
   * Returns the MoveGroup _id string stored as outboundMoveGroupId.
   */
  async createOutboundMoveGroup(
    transferId: string,
    documentNumber: string,
    items: Array<{
      product: string;
      variantSku?: string | null;
      quantity: number;
      sourceLocationId?: string;
      costPrice?: number;
    }>,
    senderBranchId: string,
    receiverBranchId: string,
    actorId?: string,
  ): Promise<string> {
    const flow = getFlowEngine();
    const senderCtx = buildFlowContext(senderBranchId, actorId ?? 'system');
    await ensureBranchBootstrapped(senderCtx.organizationId);

    const locationCache = createLocationCache();
    const dispatchItems = [];

    for (const item of items) {
      const sourceCode = await resolveLocationCode(flow, item.sourceLocationId, senderCtx, {
        cache: locationCache,
      });
      dispatchItems.push({
        moveGroupId: '',
        operationType: 'shipment',
        skuRef: skuRefFromProduct(item.product, item.variantSku),
        sourceLocationId: sourceCode,
        destinationLocationId: CUSTOMER_LOCATION,
        quantityPlanned: item.quantity,
      });
    }

    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        metadata: { transferId, documentNumber, isInternalTransfer: true, receiverBranchId },
        items: dispatchItems,
      },
      senderCtx,
    );

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, senderCtx);
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, senderCtx);

    return String(group._id);
  },

  /**
   * Create the inbound MoveGroup at the receiver branch: vendor → stock.
   * Interface: (transferId, documentNumber, items, senderBranchId, receiverBranchId, actorId?) → Promise<string>
   * Returns the MoveGroup _id string stored as inboundMoveGroupId.
   */
  async createInboundMoveGroup(
    transferId: string,
    documentNumber: string,
    items: Array<{
      product: string;
      variantSku?: string | null;
      quantity: number;
      destinationLocationId?: string;
      costPrice?: number;
      transitCost?: number;
    }>,
    senderBranchId: string,
    receiverBranchId: string,
    actorId?: string,
  ): Promise<string> {
    const flow = getFlowEngine();
    const receiverCtx = buildFlowContext(receiverBranchId, actorId ?? 'system');
    await ensureBranchBootstrapped(receiverCtx.organizationId);

    const locationCache = createLocationCache();
    const receiptItems = [];

    for (const item of items) {
      const destinationCode = await resolveLocationCode(flow, item.destinationLocationId, receiverCtx, {
        cache: locationCache,
      });
      receiptItems.push({
        moveGroupId: '',
        operationType: 'receipt',
        skuRef: skuRefFromProduct(item.product, item.variantSku),
        sourceLocationId: VENDOR_LOCATION,
        destinationLocationId: destinationCode,
        quantityPlanned: item.quantity,
        metadata: { unitCost: item.costPrice },
      });
    }

    const group = await flow.services.moveGroup.create(
      {
        groupType: 'receipt',
        metadata: { transferId, documentNumber, isInternalTransfer: true, senderBranchId },
        items: receiptItems,
      },
      receiverCtx,
    );

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, receiverCtx);
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, receiverCtx);

    return String(group._id);
  },
};

// ─── Bridge: EventTransport ────────────────────────────────────────────────

const transferEventTransport: EventTransport = {
  name: 'arc:transfer',
  async publish(event: DomainEvent<unknown>): Promise<void> {
    await publish(event.type, event.payload, event.meta);
  },
  subscribe: undefined as unknown as EventTransport['subscribe'],
};

// ─── Public API ────────────────────────────────────────────────────────────

export function initializeTransferEngine(): TransferEngine {
  if (engine) return engine;

  engine = createTransferEngine({
    connection: mongoose.connection,
    bridges: {
      sequence: sequenceBridge,
      flow: flowBridge,
    },
    eventTransport: transferEventTransport,
    autoIndex: shouldAutoIndex(),
    // transfer 0.2.0 newly wires mongokit's multiTenantPlugin (fail-closed,
    // `required: true` by default). be-prod's tenant boundary is arc's
    // RequestScope — mongokit tenancy stays OFF here, the same convention used
    // by the promo engine (`tenant: false`) and the purchase repository (which
    // extends mongokit's Repository directly without the engine's tenant
    // plugin). A stock transfer is COMPANY-scoped: it must stay visible to BOTH
    // the sender and the receiver branch (receive runs under the receiver's
    // x-organization-id), so branch-keyed mongokit scoping would hide the doc
    // from the receiving branch. Disabling matches the cross-branch contract.
    multiTenant: false,
    forceRecreate: process.env.NODE_ENV === 'test',
  });

  return engine;
}

export function getTransferEngine(): TransferEngine {
  if (!engine) {
    throw new Error('TransferEngine not initialized. Call initializeTransferEngine() first.');
  }
  return engine;
}

export function getTransferEngineOrNull(): TransferEngine | null {
  return engine;
}

export async function destroyTransferEngine(): Promise<void> {
  engine = null;
}
