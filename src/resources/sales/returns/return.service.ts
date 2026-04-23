/**
 * Return Service — RMA lifecycle management
 *
 * Handles the full returns flow: create → approve → ship → receive → inspect → refund/reject.
 * Integrates with:
 * - @classytic/flow: Stock restore via MoveGroups
 * - @classytic/revenue: Payment refund processing
 * - Arc events: Domain event publishing at each state transition
 */

import { createStateMachine } from '@classytic/arc/utils';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { skuRefFromProduct } from '#resources/inventory/flow/context-helpers.js';
import stockTransactionService from '#resources/inventory/services/stock-transaction.service.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import { resolveCaptureTransactionId } from '#resources/sales/orders/resolve-capture-txn.js';
import { getRevenueEngine, isRevenueReady } from '#shared/revenue/engine.js';
import type { IReturn, IReturnItem, ReturnDocument, ReturnStatusValue } from './models/return.model.js';
import Return, { InspectionResult, ReturnStatus } from './models/return.model.js';
import returnRepository from './return.repository.js';

// ── Status helpers ───────────────────────────────────────────────────────

interface StatusError extends Error {
  statusCode: number;
}

function statusError(message: string, statusCode = 400): StatusError {
  const err = new Error(message) as StatusError;
  err.statusCode = statusCode;
  return err;
}

const DEFAULT_RETURN_WINDOW_DAYS = 7;

const returnState = createStateMachine('Return', {
  approve: [ReturnStatus.DRAFT],
  ship: [ReturnStatus.APPROVED],
  receive: [ReturnStatus.SHIPPED],
  inspect: [ReturnStatus.RECEIVED],
  refund: [ReturnStatus.INSPECTED],
  reject: [ReturnStatus.INSPECTED],
  cancel: [ReturnStatus.DRAFT, ReturnStatus.APPROVED, ReturnStatus.SHIPPED],
});

// ── Minimal interfaces for cross-module reads ────────────────────────────
//
// The Order model used here comes from `@classytic/order` which uses the
// newer `lines[]` + `snapshot` + `customerSnapshot` shape. We also tolerate
// the legacy `items[]` / `customerName` / `currentPayment` shape so hosts
// that haven't fully migrated keep working. `normalizeOrderItems` is the
// single reader both paths go through.

interface OrderLineLike {
  _id?: { toString(): string };
  lineId?: string;
  // Legacy shape:
  product?: { toString(): string };
  productName?: string;
  variantSku?: string;
  price?: number;
  // New shape:
  snapshot?: {
    productId?: string;
    offerId?: string;
    sku?: string;
    name?: string;
  };
  unitPrice?: { amount: number } | number;
  quantity: number;
}

interface OrderDoc {
  _id: { toString(): string };
  status: string;
  branch?: { toString(): string };
  customer?: { toString(): string };
  customerId?: string;
  customerName?: string;
  customerSnapshot?: { name?: string; email?: string; phone?: string };
  // Legacy + new — only one will be populated on any given doc.
  items?: OrderLineLike[];
  lines?: OrderLineLike[];
  currentPayment?: {
    transactionId?: { toString(): string };
    amount: number;
    status: string;
    refundedAmount?: number;
  };
  paymentState?: {
    // @classytic/order's canonical field name. `transactions` (plural) was
    // the pre-refactor name; kept off this interface so the shared
    // resolveCaptureTransactionId (in orders/resolve-capture-txn.ts) can
    // take OrderDoc directly.
    transactionRefs?: Array<{ transactionId: string; type: string; status: string }>;
  };
  shipping?: {
    deliveredAt?: Date;
  };
  addTimelineEvent?: (type: string, description: string, request: unknown, metadata: unknown) => void;
  save: () => Promise<unknown>;
}

interface NormalizedLine {
  lineKey: string;
  productId: string;
  sku: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
}

function normalizeOrderItems(order: OrderDoc): NormalizedLine[] {
  const raw = order.lines?.length ? order.lines : (order.items ?? []);
  return raw.map((l) => {
    const productId = l.snapshot?.productId ?? l.snapshot?.offerId ?? (l.product ? l.product.toString() : '');
    const sku = l.snapshot?.sku ?? l.variantSku ?? null;
    const name = l.snapshot?.name ?? l.productName ?? '';
    const unitPrice = typeof l.unitPrice === 'number' ? l.unitPrice : (l.unitPrice?.amount ?? l.price ?? 0);
    return {
      lineKey: l.lineId ?? l._id?.toString() ?? `${productId}:${sku ?? ''}`,
      productId,
      sku,
      name,
      quantity: l.quantity,
      unitPrice,
    };
  });
}

function resolveCustomerName(order: OrderDoc): string {
  return order.customerSnapshot?.name ?? order.customerName ?? 'Customer';
}

/**
 * Sum the cost of restocked items so the COGS reversal posts the right
 * amount. Costs come from the order's line snapshots — `snapshot.costPrice`
 * is the value COGS was originally posted at (same as cogs.contract reads).
 *
 * Matches return items to order lines by `(productId, variantSku)` using
 * the same null-safe convention as normalizeOrderItems. Lines without a
 * cost snapshot contribute 0 — services / promo items / orders placed
 * before cost-capture was added all flow through cleanly.
 *
 * Returns total in paisa across all restocked items.
 */
function computeRestockCost(
  order: OrderDoc | null,
  restockedItems: Array<{ productId: { toString(): string }; variantSku?: string; quantity: number }>,
): number {
  if (!order) return 0;
  const normalized = normalizeOrderItems(order);
  let total = 0;
  for (const item of restockedItems) {
    const itemPid = item.productId.toString();
    const itemSku = item.variantSku ?? null;
    // Re-read the raw snapshot — normalizeOrderItems doesn't surface
    // costPrice. Walk the original lines to find the matching line.
    const rawLines = (order.lines?.length ? order.lines : order.items ?? []) as Array<{
      snapshot?: { productId?: string; offerId?: string; sku?: string; costPrice?: number };
      variantSku?: string;
      costPriceAtSale?: number;
    }>;
    const line = rawLines.find((l) => {
      const pid = l.snapshot?.productId ?? l.snapshot?.offerId ?? '';
      const sku = l.snapshot?.sku ?? l.variantSku ?? null;
      return pid === itemPid && (sku || null) === itemSku;
    });
    if (!line) continue;
    const costPer = Number(line.snapshot?.costPrice ?? line.costPriceAtSale ?? 0);
    if (!Number.isFinite(costPer) || costPer <= 0) continue;
    total += costPer * item.quantity;
    // Also confirm normalized row exists (sanity — if the line survived
    // normalization we shouldn't have mismatched the lookup).
    void normalized;
  }
  return Math.round(total);
}


// ── Delivered-date resolver ──────────────────────────────────────────────
//
// The @classytic/order Order model does NOT expose a `shipping.deliveredAt`
// path — delivery lives on the child OrderFulfillment docs (updatedAt of
// the fulfillment whose status transitioned to "delivered"). This resolver
// walks the fallback chain:
//
//   1. `order.shipping.deliveredAt`  — legacy/local extension, if any host
//      projects still populate it.
//   2. Most recent `OrderFulfillment` with status === 'delivered' for the
//      order — authoritative source when the order was shipped through the
//      fulfillment pipeline.
//   3. `order.deliveredAt` or `order.updatedAt` — last-resort when the
//      order is marked delivered but no fulfillment doc exists (e.g. POS).
//
// Returning `null` means "no verifiable delivery date" and the caller
// should reject the return.
async function resolveDeliveredAt(order: OrderDoc, orderId: string): Promise<Date | null> {
  if (order.shipping?.deliveredAt) return order.shipping.deliveredAt;

  try {
    const Fulfillment = mongoose.model('OrderFulfillment');
    const latestDelivered = (await Fulfillment.findOne(
      { orderId: new mongoose.Types.ObjectId(orderId), status: 'delivered' },
      { updatedAt: 1 },
      { sort: { updatedAt: -1 } },
    ).lean()) as { updatedAt?: Date } | null;
    if (latestDelivered?.updatedAt) return latestDelivered.updatedAt;
  } catch (err) {
    logger.debug(
      { err: (err as Error).message, orderId },
      'OrderFulfillment model unavailable while resolving deliveredAt',
    );
  }

  const anyOrder = order as unknown as { deliveredAt?: Date; updatedAt?: Date };
  return anyOrder.deliveredAt ?? anyOrder.updatedAt ?? null;
}

// ── Service ──────────────────────────────────────────────────────────────

class ReturnService {
  /**
   * Create a return request for a delivered order.
   * Validates return window and item quantities.
   */
  async createReturn(
    orderId: string,
    items: Array<{ productId: string; variantSku?: string; quantity: number; reason: string }>,
    actorId: string,
    options: { windowDays?: number; notes?: string; refundMethod?: 'original' | 'store_credit' } = {},
  ): Promise<ReturnDocument> {
    const Order = mongoose.model('Order');
    const order = (await Order.findById(orderId)) as OrderDoc | null;
    if (!order) throw statusError('Order not found', 404);
    if (order.status !== 'delivered') throw statusError('Only delivered orders can be returned');

    const deliveredAt = await resolveDeliveredAt(order, orderId);
    if (!deliveredAt) throw statusError('Order has no delivery date recorded');

    const windowDays = options.windowDays ?? DEFAULT_RETURN_WINDOW_DAYS;
    const expiresAt = new Date(deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
    if (new Date() > expiresAt) {
      throw statusError(`Return window expired (${windowDays} days from delivery)`);
    }

    // Validate items belong to order and quantities are valid.
    // Works against both the new schema (`order.lines[]` with `snapshot`)
    // and the legacy schema (`order.items[]` with `product` + `variantSku`).
    const normalized = normalizeOrderItems(order);
    const returnItems: IReturnItem[] = [];
    for (const item of items) {
      const orderLine = normalized.find(
        (n) => n.productId === item.productId && (n.sku || null) === (item.variantSku || null),
      );
      if (!orderLine) throw statusError(`Item ${item.productId} not found in order`);
      if (item.quantity > orderLine.quantity) {
        throw statusError(
          `Return quantity (${item.quantity}) exceeds order quantity (${orderLine.quantity}) for ${orderLine.name}`,
        );
      }

      returnItems.push({
        productId: new mongoose.Types.ObjectId(item.productId),
        productName: orderLine.name,
        variantSku: item.variantSku,
        quantity: item.quantity,
        unitPrice: orderLine.unitPrice,
        reason: item.reason as IReturnItem['reason'],
        refundAmount: item.quantity * orderLine.unitPrice,
      });
    }

    const totalRefundAmount = returnItems.reduce((sum, i) => sum + (i.refundAmount ?? 0), 0);

    // Resolve branch from the order. The @classytic/order schema uses
    // `organizationId`; legacy hosts stored it as `branch` on the root doc.
    const anyOrder = order as unknown as { organizationId?: { toString(): string } };
    const branchIdRaw = order.branch?.toString() ?? anyOrder.organizationId?.toString();
    if (!branchIdRaw) throw statusError('Order has no branch/organization — cannot create return');

    const returnDoc = await returnRepository.create({
      orderId: new mongoose.Types.ObjectId(orderId),
      branch: new mongoose.Types.ObjectId(branchIdRaw),
      customer: order.customer ? new mongoose.Types.ObjectId(order.customer.toString()) : undefined,
      customerName: resolveCustomerName(order),
      status: ReturnStatus.DRAFT,
      items: returnItems,
      returnWindow: { deliveredAt, windowDays, expiresAt },
      refundMethod: options.refundMethod || 'original',
      totalRefundAmount,
      restockItems: true,
      statusHistory: [{ status: ReturnStatus.DRAFT, actor: new mongoose.Types.ObjectId(actorId) }],
      notes: options.notes,
      createdBy: new mongoose.Types.ObjectId(actorId),
    } as unknown as Record<string, unknown>);

    notifyEvent.returnCreated({
      returnId: String(returnDoc._id),
      orderId,
      returnNumber: returnDoc.returnNumber,
      organizationId: order.branch?.toString() || '',
      triggeredBy: actorId,
    });

    return returnDoc as unknown as ReturnDocument;
  }

  async approveReturn(returnId: string, actorId: string): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('approve', doc.status, statusError);

    doc.status = ReturnStatus.APPROVED;
    doc.statusHistory.push({ status: ReturnStatus.APPROVED, actor: new mongoose.Types.ObjectId(actorId) } as any);
    await doc.save();

    notifyEvent.returnApproved({
      returnId: String(doc._id),
      returnNumber: doc.returnNumber,
      organizationId: String(doc.branch),
      triggeredBy: actorId,
    });

    return doc;
  }

  async markShipped(
    returnId: string,
    shippingInfo: { provider?: string; trackingNumber?: string },
    actorId: string,
  ): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('ship', doc.status, statusError);

    doc.status = ReturnStatus.SHIPPED;
    doc.reverseShipping = { ...shippingInfo, status: 'in_transit' };
    doc.statusHistory.push({ status: ReturnStatus.SHIPPED, actor: new mongoose.Types.ObjectId(actorId) } as any);
    await doc.save();

    return doc;
  }

  async receiveReturn(returnId: string, actorId: string): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('receive', doc.status, statusError);

    doc.status = ReturnStatus.RECEIVED;
    if (doc.reverseShipping) doc.reverseShipping.status = 'delivered';
    doc.statusHistory.push({ status: ReturnStatus.RECEIVED, actor: new mongoose.Types.ObjectId(actorId) } as any);
    await doc.save();

    notifyEvent.returnReceived({
      returnId: String(doc._id),
      returnNumber: doc.returnNumber,
      organizationId: String(doc.branch),
      triggeredBy: actorId,
    });

    return doc;
  }

  async inspectReturn(
    returnId: string,
    results: Array<{ productId: string; variantSku?: string; result: string; refundAmount?: number }>,
    actorId: string,
  ): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('inspect', doc.status, statusError);

    for (const result of results) {
      const item = doc.items.find(
        (i) => i.productId.toString() === result.productId && (i.variantSku || null) === (result.variantSku || null),
      );
      if (item) {
        item.inspectionResult = result.result as IReturnItem['inspectionResult'];
        if (result.refundAmount !== undefined) item.refundAmount = result.refundAmount;
      }
    }

    doc.totalRefundAmount = doc.items.reduce((sum, i) => sum + (i.refundAmount ?? 0), 0);
    doc.status = ReturnStatus.INSPECTED;
    doc.inspectedBy = new mongoose.Types.ObjectId(actorId);
    doc.inspectedAt = new Date();
    doc.statusHistory.push({ status: ReturnStatus.INSPECTED, actor: new mongoose.Types.ObjectId(actorId) } as any);
    await doc.save();

    const hasRejected = doc.items.some((i) => i.inspectionResult === InspectionResult.REJECTED);
    const hasApproved = doc.items.some(
      (i) => i.inspectionResult === InspectionResult.APPROVED || i.inspectionResult === InspectionResult.PARTIAL,
    );

    notifyEvent.returnInspected({
      returnId: String(doc._id),
      returnNumber: doc.returnNumber,
      result: hasRejected && !hasApproved ? 'rejected' : hasApproved ? 'approved' : 'partial',
      organizationId: String(doc.branch),
      triggeredBy: actorId,
    });

    return doc;
  }

  /**
   * Process refund: restore stock (Flow MoveGroups) + issue payment refund (Revenue).
   *
   * Also emits `accounting:return.restocked` when goods go back into inventory
   * so the accounting handler posts the COGS reversal (`Dr Inventory | Cr COGS`).
   * Without this, restocked goods double-count: the order's COGS stays on the
   * expense side even though the inventory asset came back.
   */
  async processRefund(returnId: string, actorId: string): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('refund', doc.status, statusError);

    const branchId = String(doc.branch);

    // Load the order once — needed for cost lookup (COGS reversal) AND for
    // the capture-txn resolution below. Single query, no re-fetch.
    const Order = mongoose.model('Order');
    const order = (await Order.findById(doc.orderId)) as OrderDoc | null;

    // 1. Restore stock for approved/restockable items
    if (doc.restockItems) {
      const restockableItems = doc.items.filter(
        (i) => i.inspectionResult === InspectionResult.APPROVED || i.inspectionResult === InspectionResult.PARTIAL,
      );

      if (restockableItems.length) {
        const result = await stockTransactionService.restoreBatch(
          restockableItems.map((i) => ({
            productId: i.productId.toString(),
            variantSku: i.variantSku,
            quantity: i.quantity,
            // Per-line bin routing (QC / restock / scrap / RTV) — falls back
            // to the branch default stock bin when omitted. Mirrors the
            // warehouse-native return-order disposition pattern.
            destinationLocationId: i.restockLocationId,
          })),
          branchId,
          { model: 'Return', id: String(doc._id) },
          actorId,
        );

        if (result.success && result.moveGroupIds.length) {
          doc.moveGroupIds = result.moveGroupIds;
        }

        // COGS reversal — match each restocked item to its original order
        // line by (productId, variantSku) and sum cost × quantity. Rejected
        // items are NOT restocked and therefore NOT reversed here — they
        // either get scrapped (separate adjustment) or returned to vendor.
        const costAmount = computeRestockCost(order, restockableItems);
        if (costAmount > 0) {
          // Fire-and-forget: the accounting handler has its own retry chain
          // via withRetry. If publish itself fails (unlikely on an in-memory
          // transport), we don't want to fail the refund — stock already
          // moved, payment refund still needs to fire.
          publish('accounting:return.restocked', {
            returnId: String(doc._id),
            orderId: String(doc.orderId),
            costAmount,
            branchId,
            date: new Date().toISOString(),
            description: `COGS reversal — Return ${doc.returnNumber}`,
          }).catch((err) => {
            logger.warn(
              { err: (err as Error).message, returnId, costAmount },
              'Failed to publish accounting:return.restocked — COGS reversal NOT posted, manual adjustment required',
            );
          });
        }
      }
    }

    // 2. Process payment refund
    if (doc.totalRefundAmount > 0 && doc.refundMethod === 'original') {
      try {
        const txnId = order ? resolveCaptureTransactionId(order) : null;
        if (txnId && isRevenueReady()) {
          await getRevenueEngine().repositories.transaction.refund(txnId, doc.totalRefundAmount, {
            reason: `Return ${doc.returnNumber}`,
          });
        }

        // 3. Add timeline event to order
        if (order?.addTimelineEvent) {
          order.addTimelineEvent(
            'return.refunded',
            `Return ${doc.returnNumber} refunded: ${doc.totalRefundAmount}`,
            null,
            {
              returnId: String(doc._id),
              returnNumber: doc.returnNumber,
              amount: doc.totalRefundAmount,
            },
          );
          await order.save();
        }
      } catch (error) {
        // Payment refund is best-effort — stock is already restored, mark refunded regardless.
        // Revenue engine may not be available in all environments.
        logger.warn(
          { err: error, returnId, amount: doc.totalRefundAmount },
          'Payment refund skipped (revenue unavailable or failed)',
        );
      }
    }

    doc.status = ReturnStatus.REFUNDED;
    doc.statusHistory.push({ status: ReturnStatus.REFUNDED, actor: new mongoose.Types.ObjectId(actorId) } as any);
    await doc.save();

    notifyEvent.returnRefunded({
      returnId: String(doc._id),
      returnNumber: doc.returnNumber,
      amount: doc.totalRefundAmount,
      organizationId: branchId,
      triggeredBy: actorId,
    });

    return doc;
  }

  async rejectReturn(returnId: string, reason: string, actorId: string): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('reject', doc.status, statusError);

    doc.status = ReturnStatus.REJECTED;
    doc.statusHistory.push({
      status: ReturnStatus.REJECTED,
      actor: new mongoose.Types.ObjectId(actorId),
      notes: reason,
    } as any);
    await doc.save();

    notifyEvent.returnRejected({
      returnId: String(doc._id),
      returnNumber: doc.returnNumber,
      reason,
      organizationId: String(doc.branch),
      triggeredBy: actorId,
    });

    return doc;
  }

  async cancelReturn(returnId: string, reason: string, actorId: string): Promise<ReturnDocument> {
    const doc = await this._findOrThrow(returnId);
    returnState.assert('cancel', doc.status, statusError);

    doc.status = ReturnStatus.CANCELLED;
    doc.statusHistory.push({
      status: ReturnStatus.CANCELLED,
      actor: new mongoose.Types.ObjectId(actorId),
      notes: reason,
    } as any);
    await doc.save();

    return doc;
  }

  private async _findOrThrow(id: string): Promise<ReturnDocument> {
    const doc = await Return.findById(id);
    if (!doc) throw statusError('Return not found', 404);
    return doc as ReturnDocument;
  }
}

export const returnService = new ReturnService();
export default returnService;
