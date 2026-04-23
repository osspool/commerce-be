import branchRepository from '#resources/commerce/branch/branch.repository.js';
import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import type { ISupplier } from '#resources/inventory/supplier/models/supplier.model.js';
import supplierRepository from '#resources/inventory/supplier/supplier.repository.js';
import type { IPurchaseOrder } from '../models/purchase-order.model.js';
import { PurchaseOrderPaymentTerms } from '../models/purchase-order.model.js';
import { normalizeNumber } from '../purchase-order.utils.js';

export interface PaymentData {
  amount?: number;
  method?: string;
  reference?: string;
  accountNumber?: string;
  walletNumber?: string;
  bankName?: string;
  accountName?: string;
  proofUrl?: string;
  transactionDate?: string;
  notes?: string;
}

export interface CreatePurchaseData {
  items?: Array<{
    productId: string;
    variantSku?: string | null;
    quantity?: number;
    costPrice?: number;
    discount?: number;
    taxRate?: number;
    notes?: string;
    destinationLocationId?: string;
  }>;
  branchId?: string;
  supplierId?: string;
  purchaseOrderNumber?: string;
  invoiceDate?: string;
  paymentTerms?: string;
  creditDays?: number;
  dueDate?: string;
  notes?: string;
  autoApprove?: boolean;
  autoReceive?: boolean;
  payment?: PaymentData;
}

export interface UpdatePurchaseData {
  purchaseOrderNumber?: string;
  invoiceDate?: string;
  notes?: string;
  supplierId?: string;
  paymentTerms?: string;
  creditDays?: number;
  dueDate?: string;
  items?: Array<{
    productId: string;
    variantSku?: string | null;
    quantity?: number;
    costPrice?: number;
    discount?: number;
    taxRate?: number;
    notes?: string;
    destinationLocationId?: string;
  }>;
}

export type SupplierDocument = ISupplier & { _id: unknown };

export interface BranchDocument {
  _id: unknown;
  code?: string;
  name?: string;
  role?: string;
}

interface ProductDocument {
  _id: unknown;
  name: string;
  sku?: string;
  isActive?: boolean;
  deletedAt?: Date | null;
  variants?: Array<{ sku?: string }>;
}

export interface TaxDetails {
  type: string;
  rate: number;
  isInclusive: boolean;
  jurisdiction: string;
}

export async function resolveHeadOfficeBranch(branchId?: string): Promise<BranchDocument> {
  let branch: BranchDocument | null;
  if (branchId) {
    branch = (await branchRepository.Model.findById(branchId).lean()) as BranchDocument | null;
    if (!branch) throw createStatusError('Branch not found', 404);
  } else {
    branch = (await branchRepository.getHeadOffice()) as BranchDocument | null;
  }

  if (!branch || branch.role !== 'head_office') {
    throw createStatusError('Purchases can only be recorded at head office', 403);
  }

  return branch;
}

export async function normalizePurchaseItems(
  items: Array<{
    productId?: string;
    variantSku?: string | null;
    quantity?: number;
    costPrice?: number;
    discount?: number;
    taxRate?: number;
    notes?: string;
    destinationLocationId?: string;
  }>,
): Promise<Array<Record<string, unknown>>> {
  const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
  const catalog = await ensureCatalogEngine();
  const catalogCtx = { actorId: 'purchase-service', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

  const productIds: string[] = [];
  for (const item of items) {
    if (!item?.productId) {
      throw createStatusError('Product ID is required for purchase items');
    }
    productIds.push(item.productId);
  }

  const uniqueIds = [...new Set(productIds.map((id) => id.toString()))];
  const products = (await catalog.repositories.product.findAll(
    { _id: { $in: uniqueIds } },
    { ...catalogCtx, lean: true },
  )) as unknown as ProductDocument[];
  const productMap = new Map(products.map((product) => [String(product._id), product]));

  return items.map((item) => {
    const quantity = normalizeNumber(item.quantity, 0);
    const costPrice = normalizeNumber(item.costPrice, 0);

    if (quantity < 0 || costPrice < 0) {
      throw createStatusError('Quantity and cost price must be non-negative');
    }

    const product = productMap.get(item.productId?.toString() || '');
    if (!product) {
      throw createStatusError(`Product not found: ${item.productId}`, 404);
    }

    if (item.variantSku) {
      const variant = (product.variants || []).find((entry) => entry?.sku === item.variantSku);
      if (!variant) {
        throw createStatusError(`Variant not found: ${item.variantSku}`, 404);
      }
    }

    return {
      product: item.productId,
      productName: product.name,
      variantSku: item.variantSku || null,
      quantity,
      costPrice,
      discount: normalizeNumber(item.discount, 0),
      taxRate: normalizeNumber(item.taxRate, 0),
      notes: item.notes,
      destinationLocationId: item.destinationLocationId,
    };
  });
}

export function resolveDueDate(params: {
  paymentTerms?: string;
  creditDays?: number;
  dueDate?: string | Date | null;
  invoiceDate?: string | Date | null;
}): Date | null {
  const { paymentTerms, creditDays, dueDate, invoiceDate } = params;
  if (paymentTerms !== PurchaseOrderPaymentTerms.CREDIT) {
    return null;
  }
  if (dueDate) return new Date(dueDate as string | Date);
  const baseDate = invoiceDate ? new Date(invoiceDate as string | Date) : new Date();
  const resolvedCreditDays = normalizeNumber(creditDays, 0);
  const next = new Date(baseDate);
  next.setDate(next.getDate() + resolvedCreditDays);
  return next;
}

export async function getSupplierById(supplierId?: string): Promise<SupplierDocument | null> {
  if (!supplierId) return null;
  return (await supplierRepository.getById(supplierId, { lean: true })) as SupplierDocument | null;
}

export type PurchaseWithId = IPurchaseOrder & { _id: string };
