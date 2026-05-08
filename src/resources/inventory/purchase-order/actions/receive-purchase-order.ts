import { createEvent } from '@classytic/primitives/events';
import type mongoose from 'mongoose';
import posLookupService from '#resources/inventory/flow/pos-lookup.service.js';
import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import { outboxStore } from '#shared/outbox/index.js';
import { getPurchaseEngine } from '#resources/inventory/_engines/purchase.engine.js';
import { PurchaseOrderStatus } from '../purchase-order.constants.js';
import { buildStatusEntry, normalizeNumber } from '../purchase-order.utils.js';
import { receiveItemsIntoStock } from './receive-items-into-stock.js';
import { getSupplierById } from './shared.js';
import { withPurchaseTransaction } from './with-purchase-order-transaction.js';

export async function receivePurchase(
  purchaseId: string,
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<Record<string, unknown>> {
  let resolvedSupplierName: string | undefined;

  return withPurchaseTransaction(
    async (session) => {
      const PurchaseOrder = getPurchaseEngine().models.PurchaseOrder;
      const purchase = session
        ? await PurchaseOrder.findById(purchaseId).session(session)
        : await PurchaseOrder.findById(purchaseId);
      if (!purchase) throw createStatusError('Purchase not found', 404);
      assertState('receive', purchase.status, createStatusError, 'Only draft or approved purchases can be received');

      if (purchase.status === PurchaseOrderStatus.DRAFT) {
        purchase.status = PurchaseOrderStatus.APPROVED;
        purchase.approvedBy = actorId as unknown as mongoose.Types.ObjectId;
        purchase.approvedAt = new Date();
        purchase.statusHistory.push(
          buildStatusEntry(
            PurchaseOrderStatus.APPROVED,
            actorId,
            'Purchase approved',
          ) as unknown as (typeof purchase.statusHistory)[0],
        );
      }

      const supplier = await getSupplierById(purchase.supplier ? String(purchase.supplier) : undefined);
      const errors = await receiveItemsIntoStock(purchase, supplier?.name);

      if (errors.length) {
        const detail = errors
          .slice(0, 3)
          .map((error) => `${error.variantSku || error.productId || 'item'}: ${error.error}`)
          .join('; ');
        throw createStatusError(`Purchase receipt failed: ${detail}`);
      }

      purchase.status = PurchaseOrderStatus.RECEIVED;
      purchase.receivedBy = actorId as unknown as mongoose.Types.ObjectId;
      purchase.receivedAt = new Date();
      purchase.updatedBy = actorId as unknown as mongoose.Types.ObjectId;
      purchase.statusHistory.push(
        buildStatusEntry(
          PurchaseOrderStatus.RECEIVED,
          actorId,
          'Purchase received',
        ) as unknown as (typeof purchase.statusHistory)[0],
      );

      if (session) {
        await purchase.save({ session });
      } else {
        await purchase.save();
      }

      resolvedSupplierName = supplier?.name;

      const grandTotal = normalizeNumber(purchase.grandTotal, 0);
      if (grandTotal > 0) {
        const taxTotal = normalizeNumber(purchase.taxTotal, 0);
        // PO model persists totals in BDT major units (`grandTotal: 5520` = ৳5,520).
        // Accounting handlers / posting contracts work in paisa (`debit: number //
        // paisa` per posting.service.ts). Convert at the publish boundary so
        // the journal entry's `Dr/Cr` amounts match the actual money paid.
        // Without this we'd post entries 100× too small (৳55.20 instead of ৳5,520).
        const grandTotalPaisa = Math.round(grandTotal * 100);
        const taxTotalPaisa = Math.round(taxTotal * 100);
        const currency = purchase.currency || 'BDT';
        const exchangeRate = purchase.exchangeRate || undefined;
        // Propagate the purchase's dominant VAT rate so the posting contract
        // can select the correct input-VAT sub-account (1150.VAT15.INPUT vs
        // 1150.VAT7_5.INPUT vs null for non-claimable rates). If items have
        // mixed rates, leave undefined so the handler falls back to STANDARD.
        const items = (purchase.items as Array<{ taxRate?: number }> | undefined) ?? [];
        const rates = new Set(items.map((i) => normalizeNumber(i.taxRate, 0)));
        const vatRate = rates.size === 1 ? [...rates][0] : undefined;

        // Two mutually-exclusive accounting paths, picked from the PO doc:
        //
        //   - Cash purchase (paymentTerms='cash' OR no supplier) → publish
        //     `accounting:purchase.paid`. The handler posts the everything-
        //     in-one PURCHASES JE: Dr Inv + Dr VAT / Cr Bank.
        //
        //   - Credit purchase (paymentTerms='credit' AND supplier set) →
        //     publish `purchase:received`. The handler posts the accrual-
        //     correct vendor-bill JE: Dr Inv + Dr VAT / Cr A/P, with the
        //     credit line tagged with `partnerId: supplierId` and a
        //     `maturityDate` so payment reconciliation can match against
        //     it later.
        //
        // Publishing both would double-post the GL entry. The two events
        // exist because the bill workflow (Phase 1 A/P) supersedes the
        // simpler all-in-one posting only when a supplier exists to attach
        // the partnerId to.
        const isCreditWithSupplier = purchase.paymentTerms !== 'cash' && !!purchase.supplier;

        if (isCreditWithSupplier) {
          const billEvent = createEvent(
            'purchase:received',
            {
              purchaseId: String(purchase._id),
              organizationId: String(purchase.branch || ''),
            },
            {
              resource: 'purchase',
              resourceId: String(purchase._id),
              userId: actorId,
              organizationId: String(purchase.branch || ''),
              source: 'commerce',
              idempotencyKey: `purchase:${String(purchase._id)}:bill`,
            },
          );
          await outboxStore.save(billEvent, {
            session: session ?? undefined,
            dedupeKey: billEvent.meta.idempotencyKey,
          });
        } else {
          const event = createEvent(
            'accounting:purchase.paid',
            {
              purchaseId: String(purchase._id),
              amount: grandTotalPaisa,
              tax: taxTotalPaisa,
              ...(vatRate !== undefined ? { vatRate } : {}),
              isPaid: purchase.paymentTerms === 'cash',
              inventoryType: 'merchandise' as const,
              branchId: String(purchase.branch || ''),
              ...(currency !== 'BDT' && exchangeRate
                ? {
                    currency,
                    exchangeRate,
                    foreignTotal: Math.round(grandTotalPaisa / exchangeRate),
                  }
                : {}),
            },
            {
              resource: 'purchase',
              resourceId: String(purchase._id),
              userId: actorId,
              organizationId: String(purchase.branch || ''),
              source: 'commerce',
              idempotencyKey: `purchase:${String(purchase._id)}:received`,
            },
          );
          await outboxStore.save(event, {
            session: session ?? undefined,
            dedupeKey: event.meta.idempotencyKey,
          });
        }
      }

      // Two-step cast: Mongoose hydrated docs aren't structurally
      // assignable to a plain Record, so go through `unknown` per TS
      // conversion rules. Safe because `toObject()` returns POJO data.
      const plain = purchase.toObject() as unknown;
      return plain as Record<string, unknown>;
    },
    {
      onCommit: async (purchase) => {
        notifyEvent.purchaseReceived({
          purchaseId: String(purchase._id),
          invoiceNumber: String(purchase.invoiceNumber || ''),
          organizationId: String(purchase.branch || ''),
          branchId: String(purchase.branch || ''),
          supplierId: purchase.supplier ? String(purchase.supplier) : undefined,
          supplierName: resolvedSupplierName,
          totalAmount: purchase.grandTotal as number | undefined,
          triggeredBy: actorId,
        });

        const items = purchase.items as Array<{ product: string | { toString(): string } }> | undefined;
        if (!items?.length) return;
        for (const item of items) {
          posLookupService.invalidateCacheForProduct(item.product);
        }
      },
    },
  );
}
