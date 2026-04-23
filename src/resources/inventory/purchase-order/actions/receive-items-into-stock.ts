import { setProductCostPriceSnapshot } from '#resources/catalog/products/product.costPrice.service.js';
import { buildFlowContext, skuRefFromProduct, VENDOR_LOCATION } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngine } from '#resources/inventory/flow/flow-engine.js';
import {
  createLocationCache,
  LocationResolutionError,
  resolveLocationCode,
} from '#resources/inventory/flow/location-resolver.js';
import { ensureBranchBootstrapped } from '#resources/inventory/inventory-management.plugin.js';
import type { PurchaseOrderDocument } from '../models/purchase-order.model.js';

export async function receiveItemsIntoStock(
  purchase: PurchaseOrderDocument,
  supplierName: string | undefined,
): Promise<Array<{ productId: string; variantSku?: string | null; error: string }>> {
  const flow = getFlowEngine();
  const ctx = buildFlowContext(String(purchase.branch), String(purchase.createdBy ?? ''));
  const locationCache = createLocationCache();
  const errors: Array<{ productId: string; variantSku?: string | null; error: string }> = [];

  interface ResolvedItem {
    productId: string;
    variantSku: string | null;
    skuRef: string;
    quantity: number;
    costPrice: number;
    destinationLocationCode: string;
  }

  const resolved: ResolvedItem[] = [];
  for (const item of purchase.items) {
    const productId = String(item.product);
    const variantSku = item.variantSku || null;
    try {
      const destinationLocationCode = await resolveLocationCode(flow, item.destinationLocationId, ctx, {
        cache: locationCache,
      });
      resolved.push({
        productId,
        variantSku,
        skuRef: skuRefFromProduct(productId, variantSku),
        quantity: Number(item.quantity ?? 0),
        costPrice: Number(item.costPrice ?? 0),
        destinationLocationCode,
      });
    } catch (error) {
      if (error instanceof LocationResolutionError) {
        errors.push({ productId, variantSku, error: error.message });
      } else {
        throw error;
      }
    }
  }

  const receivable = resolved.filter((item) => item.quantity > 0);
  if (receivable.length > 0) {
    await ensureBranchBootstrapped(ctx.organizationId);
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'receipt',
        metadata: {
          purchaseId: String(purchase._id),
          supplierInvoice: purchase.invoiceNumber,
          purchaseOrderNumber: purchase.purchaseOrderNumber,
          vendorRef: supplierName || 'unknown-vendor',
          notes: purchase.notes,
        },
        items: receivable.map((item) => ({
          moveGroupId: '',
          operationType: 'receipt',
          skuRef: item.skuRef,
          sourceLocationId: VENDOR_LOCATION,
          destinationLocationId: item.destinationLocationCode,
          quantityPlanned: item.quantity,
          metadata: { unitCost: item.costPrice },
        })),
      },
      ctx,
    );
    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);
  }

  for (const item of resolved) {
    if (item.quantity === 0 && item.costPrice > 0) {
      const snapshotCost = Math.round(item.costPrice * 100) / 100;
      await flow.repositories.quant.upsert({
        organizationId: ctx.organizationId,
        skuRef: item.skuRef,
        locationId: item.destinationLocationCode,
        quantityDelta: 0,
        unitCost: snapshotCost,
        inDate: new Date(),
      });
      await setProductCostPriceSnapshot(item.productId, item.variantSku, snapshotCost);
      continue;
    }

    if (item.quantity > 0 && item.costPrice > 0) {
      const availability = await flow.services.quant.getAvailability(
        { skuRef: item.skuRef, locationId: item.destinationLocationCode },
        ctx,
      );
      const finalCost = availability.breakdowns?.[0]?.unitCost ?? item.costPrice;
      await setProductCostPriceSnapshot(item.productId, item.variantSku, Math.round(finalCost * 100) / 100);
    }
  }

  return errors;
}
