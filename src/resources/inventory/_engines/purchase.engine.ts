/**
 * Purchase Engine Singleton
 *
 * Wires @classytic/purchase with three be-prod bridges:
 *
 *   SequenceBridge   — delegates to InventoryCounter (Flow's Counter model),
 *                      which atomically increments PINV-YYYYMM sequences using
 *                      the system-org sentinel so numbers are globally unique
 *                      across branches.
 *
 *   StockReceiptBridge — calls the existing receiveItemsIntoStock() helper,
 *                        which creates a Flow MoveGroup (vendor → stock) in the
 *                        receiving branch's context and confirms + receives it.
 *
 *   EventTransport   — wraps arcEvents.publish so purchase domain events land
 *                      on the same bus as Arc CRUD events (MemoryEventTransport
 *                      → Redis / Kafka at scale-out).
 *
 * Call initializePurchaseEngine() inside the Fastify plugin onReady hook (after
 * initializeFlowEngine) — both engines share the same mongoose.connection so
 * order doesn't matter for the connection itself, but Flow must be up first
 * because the StockReceiptBridge calls getFlowEngine() at receipt time.
 *
 * TODO: remove @ts-ignore comments after cp-dist places the built package at
 *       be-prod/node_modules/@classytic/purchase/.
 */

import { createPurchaseEngine, type PurchaseEngine } from '@classytic/purchase/engine';
import type { SequenceBridge, StockReceiptBridge, StockReceiptItem } from '@classytic/purchase/domain';
import type { PurchaseOrderDocument } from '@classytic/purchase';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import { InventoryCounter } from '#resources/inventory/flow/counter-bridge.js';
import { receiveItemsIntoStock } from '#resources/inventory/purchase-order/actions/receive-items-into-stock.js';
import { shouldAutoIndex } from '#shared/db/auto-index.js';

// ─── Singletons ────────────────────────────────────────────────────────────

let engine: PurchaseEngine | null = null;

// ─── Bridge implementations ────────────────────────────────────────────────

/**
 * SequenceBridge — delegates to InventoryCounter.nextSeq().
 *
 * Format returned: PINV-YYYYMM-NNNN (e.g. PINV-202601-0042).
 * The Counter model atomically increments a per-yearMonth key using the
 * SYSTEM_ORG_SENTINEL so the sequence spans all branches.
 */
const sequenceBridge: SequenceBridge = {
  async nextInvoiceNumber(): Promise<string> {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const seq = await InventoryCounter.nextSeq('PINV', ym);
    return `PINV-${ym}-${String(seq).padStart(4, '0')}`;
  },
};

/**
 * StockReceiptBridge — delegates to receiveItemsIntoStock() in be-prod.
 *
 * receiveItemsIntoStock() already handles:
 *   - building a FlowContext from branch + actor
 *   - resolving per-item destination location codes
 *   - creating + confirming + receiving a Flow MoveGroup (vendor → stock)
 *   - snapshotting cost prices on quants
 *
 * The bridge adapts the @classytic/purchase item shape to the form that
 * receiveItemsIntoStock() expects via a synthetic PurchaseOrderDocument stub.
 */
const stockReceiptBridge: StockReceiptBridge = {
  async receiveItems(
    purchaseId: string,
    branchId: string,
    items: StockReceiptItem[],
    meta: { supplierId?: string; supplierName?: string; actorId?: string },
  ): Promise<void> {
    // Adapt the bridge payload to the PurchaseOrderDocument shape that
    // receiveItemsIntoStock() reads. Only the fields it actually accesses
    // need to be populated — see the function's implementation for the
    // full set: _id, branch, createdBy, items[].{product, variantSku,
    // quantity, costPrice, destinationLocationId}, invoiceNumber,
    // purchaseOrderNumber, notes.
    const stub = {
      _id: purchaseId,
      branch: branchId,
      createdBy: meta.actorId ?? 'system',
      invoiceNumber: purchaseId,
      purchaseOrderNumber: undefined,
      notes: '',
      items: items.map((item) => ({
        product: item.productId,
        variantSku: item.variantSku ?? null,
        quantity: item.quantity,
        costPrice: item.costPrice,
        destinationLocationId: item.destinationLocationId,
        notes: item.notes ?? '',
      })),
    } as unknown as PurchaseOrderDocument;

    await receiveItemsIntoStock(stub, meta.supplierName);
  },
};

/**
 * EventTransport — wraps arcEvents.publish.
 *
 * @classytic/purchase's EventTransport interface expects:
 *   publish(event: { type: string; payload: unknown; meta?: Record<string, unknown> }): Promise<void>
 *
 * arcEvents.publish(type, payload, meta) is structurally compatible after
 * this thin adapter. Purchase domain events (purchase.order.created etc.)
 * land on the same MemoryEventTransport bus as Arc CRUD events.
 */
const purchaseEventTransport: EventTransport = {
  name: 'arc:purchase',
  async publish(event: DomainEvent<unknown>): Promise<void> {
    await publish(event.type, event.payload, event.meta);
  },
  // subscribe() is not required by the engine — only publish is called
  // by PurchaseOrderRepository.publishEvent(). The cast satisfies the
  // full EventTransport interface so TypeScript is happy.
  subscribe: undefined as unknown as EventTransport['subscribe'],
};

// ─── Public API ────────────────────────────────────────────────────────────

export function initializePurchaseEngine(): PurchaseEngine {
  if (engine) return engine;

  engine = createPurchaseEngine({
    connection: mongoose.connection,
    bridges: {
      sequence: sequenceBridge,
      stockReceipt: stockReceiptBridge,
      // catalog bridge: omitted intentionally. Items are created by the
      // be-prod purchase-order controller (purchaseOrderController) which
      // already performs productName + costPrice enrichment before calling
      // the repository. Wiring a second catalog lookup here would double-hit
      // the catalog service on every create. Re-enable if the clean resource
      // bypasses the controller's enrichment step.
    },
    eventTransport: purchaseEventTransport,
    autoIndex: shouldAutoIndex(),
    // purchase 0.2.0 (via mongokit 3.16 / repo-core 0.6) now defaults its
    // PurchaseOrder model to a REQUIRED `organizationId` tenant field + a
    // fail-closed multiTenantPlugin. be-prod's tenant boundary is arc's
    // RequestScope (purchase orders are head-office/company-scoped — see the
    // "company-wide" branch-isolation assertions), and be-prod's
    // PurchaseOrderRepository extends mongokit's Repository directly without
    // the engine's tenant plugin, so create() never supplies organizationId.
    // Disable mongokit tenancy so the schema field is no longer required —
    // same convention as the transfer + promo engines.
    tenant: false,
    // Vitest isolates each test file's module scope (engine = null) while the
    // Mongoose connection persists models across files. forceRecreate deletes
    // and re-registers stale models so engine init is idempotent per file.
    forceRecreate: process.env.NODE_ENV === 'test',
  });

  return engine;
}

export function getPurchaseEngine(): PurchaseEngine {
  if (!engine) {
    throw new Error('PurchaseEngine not initialized. Call initializePurchaseEngine() first.');
  }
  return engine;
}

export function getPurchaseEngineOrNull(): PurchaseEngine | null {
  return engine;
}

export async function destroyPurchaseEngine(): Promise<void> {
  // PurchaseEngine has no explicit destroy() — Mongoose connection lifecycle
  // is managed by be-prod's app startup/shutdown hooks. Null the singleton
  // so tests can reinitialize with a fresh in-memory connection.
  engine = null;
}
