/**
 * Purchase Service — powered by @classytic/flow
 *
 * Stock entry at head office from suppliers.
 * Uses Flow's ProcurementService for stock mutation and WAC cost.
 *
 * Business Rules:
 * - Stock can only be added at head office
 * - Flow handles atomic quant updates with WAC cost
 * - Expense transactions created separately (financial concern)
 */
import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import logger from '#lib/utils/logger.js';
import { setProductCostPriceSnapshot } from '#resources/catalog/products/product.costPrice.service.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import {
  getFlowEngine,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  ADJUSTMENT_LOCATION,
} from '../flow/index.js';

interface PurchaseItem {
  productId: string;
  variantSku?: string | null;
  quantity?: number;
  costPrice?: number | null;
}

interface TransactionData {
  paymentMethod?: string;
  reference?: string;
  walletNumber?: string;
  walletType?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  proofUrl?: string;
}

interface PurchaseData {
  items: PurchaseItem[];
  branchId?: string;
  purchaseOrderNumber?: string;
  purchaseId?: string;
  supplierName?: string;
  supplierInvoice?: string;
  notes?: string;
  createTransaction?: boolean;
  transactionData?: TransactionData;
}

interface PurchaseResultItem {
  productId: string;
  productName: string;
  variantSku?: string | null;
  quantity: number;
  newBalance: number;
  costPrice: number;
  inputCostPrice: number | null;
  lineValue: number;
}

interface PurchaseErrorItem {
  item: PurchaseItem;
  error: string;
}

interface PurchaseResult {
  success: boolean;
  branch: { _id: unknown; code: string; name: string };
  purchaseOrderNumber?: string;
  supplierName?: string;
  items: PurchaseResultItem[];
  errors?: PurchaseErrorItem[];
  summary: {
    totalItems: number;
    totalQuantity: number;
    totalValue: number;
  };
  transaction: { _id: unknown; amount: number } | null;
}

interface BranchDocument {
  _id: unknown;
  code: string;
  name: string;
  role: string;
}

interface ProductDocument {
  _id: unknown;
  name: string;
  sku?: string;
  variants?: Array<{ sku?: string }>;
}

class PurchaseService {
  /**
   * Record a purchase (stock entry) via Flow.
   */
  async recordPurchase(
    data: PurchaseData,
    actorId: string,
    _options: { session?: ClientSession | null; emitEvents?: boolean } = {},
  ): Promise<PurchaseResult> {
    const {
      items,
      branchId,
      purchaseOrderNumber,
      purchaseId,
      supplierName,
      supplierInvoice,
      notes,
      createTransaction,
      transactionData = {},
    } = data;

    const shouldCreateTransaction = createTransaction ?? Boolean(supplierName || supplierInvoice);

    // Resolve branch — must be head office
    let branch: BranchDocument;
    if (branchId) {
      const found = (await branchRepository.Model.findById(branchId).lean()) as BranchDocument | null;
      if (!found) throw new Error('Branch not found');
      branch = found;
    } else {
      branch = (await branchRepository.getHeadOffice()) as unknown as BranchDocument;
    }

    if (branch.role !== 'head_office') {
      throw new Error('Stock purchases can only be made at head office');
    }

    if (!items?.length) throw new Error('Purchase must include at least one item');

    const flow = getFlowEngine();
    const ctx = buildFlowContext(branch._id as string, actorId);
    const Product = mongoose.model('Product');

    const results: PurchaseResultItem[] = [];
    const errors: PurchaseErrorItem[] = [];

    for (const item of items) {
      try {
        const { productId, variantSku, quantity, costPrice } = item;

        if (!productId) {
          errors.push({ item, error: 'Product ID is required' });
          continue;
        }

        const normalizedQuantity = Number(quantity ?? 0);
        if (Number.isNaN(normalizedQuantity) || normalizedQuantity < 0) {
          errors.push({ item, error: 'Quantity must be zero or positive' });
          continue;
        }

        const normalizedCostPrice = costPrice === undefined || costPrice === null ? null : Number(costPrice);
        if (normalizedCostPrice !== null && (Number.isNaN(normalizedCostPrice) || normalizedCostPrice < 0)) {
          errors.push({ item, error: 'Cost price must be a non-negative number' });
          continue;
        }

        if (normalizedQuantity === 0 && normalizedCostPrice === null) {
          errors.push({ item, error: 'Either quantity must be > 0 or costPrice must be provided' });
          continue;
        }

        // Verify product exists
        const product = (await Product.findById(productId)
          .select('name sku variants')
          .lean()) as ProductDocument | null;
        if (!product) {
          errors.push({ item, error: `Product not found: ${productId}` });
          continue;
        }

        if (variantSku) {
          const variant = (product.variants || []).find((v) => v?.sku === variantSku);
          if (!variant) {
            errors.push({ item, error: `Variant not found: ${variantSku}` });
            continue;
          }
        }

        const skuRef = skuRefFromProduct(productId, variantSku);

        if (normalizedQuantity > 0) {
          // Create adjustment MoveGroup to add stock (adjustment → stock)
          const group = await flow.services.moveGroup.create(
            {
              groupType: 'adjustment',
              items: [
                {
                  moveGroupId: '',
                  operationType: 'adjustment',
                  skuRef,
                  sourceLocationId: ADJUSTMENT_LOCATION,
                  destinationLocationId: DEFAULT_LOCATION,
                  quantityPlanned: normalizedQuantity,
                  metadata: { purchaseId, supplierName, costPrice: normalizedCostPrice },
                },
              ],
              notes:
                [
                  supplierName && `Supplier: ${supplierName}`,
                  supplierInvoice && `Invoice: ${supplierInvoice}`,
                  purchaseOrderNumber && `PO: ${purchaseOrderNumber}`,
                  notes,
                ]
                  .filter(Boolean)
                  .join('. ') || 'Stock purchase',
            },
            ctx,
          );

          await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
          await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);
        }

        // Update cost on quant if provided (WAC or cost-only correction)
        if (normalizedCostPrice !== null) {
          const currentAvail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);

          const currentQty = currentAvail.quantityOnHand;
          const currentCost = currentAvail.breakdowns?.[0]?.unitCost ?? 0;

          let newCost: number;
          if (normalizedQuantity === 0) {
            // Cost-only correction
            newCost = normalizedCostPrice;
          } else if (currentQty > 0) {
            const oldQty = currentQty - normalizedQuantity; // qty before this purchase
            newCost = (oldQty * currentCost + normalizedQuantity * normalizedCostPrice) / currentQty;
          } else {
            newCost = normalizedCostPrice;
          }

          // Set unitCost on the quant
          await flow.repositories.quant.upsert({
            organizationId: ctx.organizationId,
            skuRef,
            locationId: DEFAULT_LOCATION,
            quantityDelta: 0,
            unitCost: Math.round(newCost * 100) / 100,
            inDate: new Date(),
          });

          // Sync cost snapshot to Product model
          await setProductCostPriceSnapshot(productId, variantSku || null, Math.round(newCost * 100) / 100);
        }

        // Get final balance
        const finalAvail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);

        results.push({
          productId,
          productName: product.name,
          variantSku,
          quantity: normalizedQuantity,
          newBalance: finalAvail.quantityOnHand,
          costPrice: finalAvail.breakdowns?.[0]?.unitCost ?? normalizedCostPrice ?? 0,
          inputCostPrice: normalizedCostPrice,
          lineValue: normalizedCostPrice !== null ? normalizedQuantity * normalizedCostPrice : 0,
        });
      } catch (error) {
        errors.push({ item, error: (error as Error).message });
      }
    }

    // Expense transaction (same as before — financial concern, not inventory)
    let transaction: { _id: unknown; amount: number } | null = null;
    if (shouldCreateTransaction && results.length > 0) {
      const totalValue = results.reduce((sum, r) => sum + (r.lineValue || 0), 0);
      if (totalValue > 0) {
        try {
          transaction = await createVerifiedOperationalExpenseTransaction({
            amountBdt: totalValue,
            category: 'inventory_purchase',
            method: transactionData.paymentMethod || 'cash',
            paymentDetails: {
              trxId: transactionData.reference,
              walletNumber: transactionData.walletNumber,
              walletType: transactionData.walletType,
              bankName: transactionData.bankName,
              accountNumber: transactionData.accountNumber,
              accountName: transactionData.accountName,
              proofUrl: transactionData.proofUrl,
            },
            sourceModel: purchaseId ? 'Purchase' : 'Manual',
            sourceId: purchaseId || undefined,
            branchId: String(branch._id),
            branchCode: branch.code,
            source: 'api',
            metadata: {
              branchId: String(branch._id),
              branchCode: branch.code,
              supplierName,
              supplierInvoice,
              purchaseOrderNumber,
              itemCount: results.length,
            },
            notes: [
              supplierName && `Supplier: ${supplierName}`,
              supplierInvoice && `Invoice: ${supplierInvoice}`,
              `${results.length} items, total ৳${totalValue}`,
            ]
              .filter(Boolean)
              .join('. '),
            verifiedBy: actorId,
          });
        } catch (txError) {
          logger.error({ err: txError }, 'Failed to create purchase transaction');
        }
      }
    }

    return {
      success: errors.length === 0,
      branch: { _id: branch._id, code: branch.code, name: branch.name },
      purchaseOrderNumber,
      supplierName,
      items: results,
      ...(errors.length > 0 ? { errors } : {}),
      summary: {
        totalItems: results.length,
        totalQuantity: results.reduce((s, r) => s + r.quantity, 0),
        totalValue: results.reduce((s, r) => s + (r.lineValue || 0), 0),
      },
      transaction: transaction ? { _id: transaction._id, amount: transaction.amount } : null,
    };
  }

  /**
   * Add stock for a single item (convenience wrapper)
   */
  async addStock(
    data: {
      productId: string;
      variantSku?: string;
      quantity: number;
      costPrice?: number;
      branchId?: string;
      notes?: string;
    },
    actorId: string,
  ): Promise<PurchaseResult> {
    const { productId, variantSku, quantity, costPrice, branchId, notes } = data;
    return this.recordPurchase(
      {
        items: [{ productId, variantSku, quantity, costPrice }],
        branchId,
        notes,
      },
      actorId,
    );
  }

  /**
   * Get purchase history (queries Flow StockMove)
   */
  async getPurchaseHistory(
    filters: { branchId?: string; productId?: string } = {},
    options: { limit?: number } = {},
  ): Promise<{ docs: unknown[]; total: number }> {
    const flow = getFlowEngine();

    if (filters.branchId) {
      const ctx = buildFlowContext(filters.branchId);
      const moves = await flow.repositories.move.findMany(
        { operationType: 'adjustment', ...(filters.productId ? { skuRef: filters.productId } : {}) },
        ctx,
      );
      return { docs: moves.slice(0, options.limit || 50), total: moves.length };
    }

    return { docs: [], total: 0 };
  }
}

export default new PurchaseService();
