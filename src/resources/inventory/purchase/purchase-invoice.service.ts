import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import { createStateMachine } from '@classytic/arc/utils';
import Purchase, { PurchaseStatus, PurchasePaymentStatus, PurchasePaymentTerms } from './models/purchase.model.js';
import type { IPurchase, PurchaseDocument, IStatusHistory } from './models/purchase.model.js';
import purchaseRepository from './purchase.repository.js';
import supplierRepository from '../supplier/supplier.repository.js';
import type { ISupplier } from '../supplier/models/supplier.model.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import purchaseEntryService from './purchase.service.js';
import posLookupService from '../flow/pos-lookup.service.js';
import logger from '#lib/utils/logger.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import { computePurchaseTotals, computePaymentStatus, normalizeNumber, buildStatusEntry } from './purchase.utils.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import { createStatusError } from '../shared/status-errors.js';

const purchaseState = createStateMachine('Purchase', {
  update: [PurchaseStatus.DRAFT],
  approve: [PurchaseStatus.DRAFT],
  receive: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED],
  cancel: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED],
  pay: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED, PurchaseStatus.RECEIVED],
});

interface CreatePurchaseData {
  items?: Array<{
    productId: string;
    variantSku?: string | null;
    quantity?: number;
    costPrice?: number;
    discount?: number;
    taxRate?: number;
    notes?: string;
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

interface PaymentData {
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

interface UpdatePurchaseData {
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
  }>;
}

type SupplierDocument = ISupplier & { _id: unknown };

interface BranchDocument {
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

interface TaxDetails {
  type: string;
  rate: number;
  isInclusive: boolean;
  jurisdiction: string;
}

class PurchaseInvoiceService {
  private async _withTransaction<T>(
    operation: (session: ClientSession | null) => Promise<T>,
    options: { onCommit?: (result: T) => Promise<void> } = {},
  ): Promise<T> {
    const { onCommit } = options;
    const result = await purchaseRepository.withTransaction((session: ClientSession | null) => operation(session), {
      allowFallback: true,
      onFallback: (error: Error) => {
        logger.warn({ err: error }, 'Transactions not supported; falling back to non-transactional purchase flow');
      },
    });

    if (onCommit) {
      await onCommit(result);
    }

    return result;
  }

  async create(
    data: CreatePurchaseData,
    options: { user?: { _id?: string }; context?: { user?: { _id?: string } } } = {},
  ): Promise<unknown> {
    const actorId = options.user?._id || options.context?.user?._id;
    return this.createPurchase(data, actorId);
  }

  async getAll(
    paginationParams: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    return purchaseRepository.getAll(paginationParams, options);
  }

  async getById(id: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return purchaseRepository.getById(id, options);
  }

  async update(
    id: string,
    data: UpdatePurchaseData,
    options: { user?: { _id?: string }; context?: { user?: { _id?: string } } } = {},
  ): Promise<unknown> {
    const actorId = options.user?._id || options.context?.user?._id;
    return this.updateDraftPurchase(id, data, actorId);
  }

  async delete(): Promise<never> {
    throw createStatusError('Deleting purchases is not allowed', 405);
  }

  async createPurchase(data: CreatePurchaseData, actorId: string | undefined): Promise<unknown> {
    const {
      items,
      branchId,
      supplierId,
      purchaseOrderNumber,
      invoiceDate,
      paymentTerms,
      creditDays,
      dueDate,
      notes,
      autoApprove,
      autoReceive,
      payment,
    } = data || {};

    if (!items?.length) {
      throw createStatusError('Purchase must include at least one item');
    }

    const branch = await this._resolveHeadOfficeBranch(branchId);

    const supplier: SupplierDocument | null = supplierId
      ? ((await supplierRepository.getById(supplierId, { lean: true })) as SupplierDocument | null)
      : null;

    const normalizedItems = await this._normalizeItems(items);
    const totals = computePurchaseTotals(normalizedItems);

    const resolvedPaymentTerms = paymentTerms || supplier?.paymentTerms || PurchasePaymentTerms.CASH;
    const resolvedCreditDays = Number.isFinite(creditDays)
      ? normalizeNumber(creditDays, 0)
      : normalizeNumber(supplier?.creditDays, 0);

    const resolvedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
    const resolvedDueDate = this._resolveDueDate({
      paymentTerms: resolvedPaymentTerms,
      creditDays: resolvedCreditDays,
      dueDate,
      invoiceDate: resolvedInvoiceDate,
    });

    const invoiceNumber = await Purchase.generateInvoiceNumber();

    let purchase: unknown = await purchaseRepository.create({
      invoiceNumber,
      purchaseOrderNumber,
      supplier: supplier?._id,
      branch: branch._id,
      invoiceDate: resolvedInvoiceDate,
      paymentTerms: resolvedPaymentTerms,
      creditDays: resolvedCreditDays,
      dueDate: resolvedDueDate,
      status: PurchaseStatus.DRAFT,
      paymentStatus: PurchasePaymentStatus.UNPAID,
      items: totals.items,
      subTotal: totals.subTotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      paidAmount: 0,
      dueAmount: totals.grandTotal,
      statusHistory: [buildStatusEntry(PurchaseStatus.DRAFT, actorId, 'Purchase created')],
      createdBy: actorId,
      updatedBy: actorId,
      notes,
    });

    const shouldApprove = Boolean(autoApprove || autoReceive);

    if (shouldApprove) {
      purchase = await this.approvePurchase(String((purchase as { _id: unknown })._id), actorId);
    }

    if (autoReceive) {
      purchase = await this.receivePurchase(String((purchase as { _id: unknown })._id), actorId);
    }

    if (payment) {
      purchase = await this.payPurchase(String((purchase as { _id: unknown })._id), payment, actorId);
    }

    return purchase;
  }

  async updateDraftPurchase(
    purchaseId: string,
    data: UpdatePurchaseData,
    actorId: string | undefined,
  ): Promise<unknown> {
    const purchase = (await purchaseRepository.getById(purchaseId, { lean: true })) as
      | (IPurchase & { _id: string })
      | null;
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert('update', purchase.status, createStatusError, 'Only draft purchases can be updated');

    const updates: Record<string, unknown> = {};
    if (data.purchaseOrderNumber !== undefined) updates.purchaseOrderNumber = data.purchaseOrderNumber;
    if (data.invoiceDate) updates.invoiceDate = new Date(data.invoiceDate);
    if (data.notes !== undefined) updates.notes = data.notes;

    if (data.supplierId) {
      const supplier = (await supplierRepository.getById(data.supplierId, { lean: true })) as SupplierDocument | null;
      if (!supplier) throw createStatusError('Supplier not found', 404);
      updates.supplier = supplier._id;
      if (!data.paymentTerms) {
        updates.paymentTerms = supplier.paymentTerms;
      }
      if (!Number.isFinite(data.creditDays)) {
        updates.creditDays = supplier.creditDays || 0;
      }
    }

    if (data.paymentTerms) updates.paymentTerms = data.paymentTerms;
    if (Number.isFinite(data.creditDays)) updates.creditDays = normalizeNumber(data.creditDays, 0);
    if (data.dueDate) updates.dueDate = new Date(data.dueDate);

    if (data.items?.length) {
      const normalizedItems = await this._normalizeItems(data.items);
      const totals = computePurchaseTotals(normalizedItems);
      if ((purchase.paidAmount || 0) > totals.grandTotal) {
        throw createStatusError('Updated total cannot be less than paid amount');
      }
      updates.items = totals.items;
      updates.subTotal = totals.subTotal;
      updates.discountTotal = totals.discountTotal;
      updates.taxTotal = totals.taxTotal;
      updates.grandTotal = totals.grandTotal;

      const payment = computePaymentStatus(totals.grandTotal, purchase.paidAmount || 0);
      updates.paymentStatus = payment.paymentStatus;
      updates.dueAmount = payment.dueAmount;
    }

    if (updates.paymentTerms || updates.creditDays || updates.invoiceDate) {
      updates.dueDate = this._resolveDueDate({
        paymentTerms: (updates.paymentTerms as string) || purchase.paymentTerms,
        creditDays: (updates.creditDays as number) ?? purchase.creditDays,
        dueDate: (updates.dueDate as Date | string | undefined) || purchase.dueDate,
        invoiceDate: (updates.invoiceDate as Date) || purchase.invoiceDate,
      });
    }

    updates.updatedBy = actorId;

    return purchaseRepository.update(purchaseId, updates);
  }

  async approvePurchase(purchaseId: string, actorId: string | undefined): Promise<IPurchase> {
    const purchase = (await purchaseRepository.getById(purchaseId, { lean: true })) as
      | (IPurchase & { _id: string })
      | null;
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert('approve', purchase.status, createStatusError, 'Only draft purchases can be approved');

    return purchaseRepository.appendStatus(
      purchaseId,
      buildStatusEntry(PurchaseStatus.APPROVED, actorId, 'Purchase approved') as unknown as IStatusHistory,
      {
        status: PurchaseStatus.APPROVED,
        approvedBy: actorId,
        approvedAt: new Date(),
        updatedBy: actorId,
      },
    ) as Promise<IPurchase>;
  }

  async receivePurchase(purchaseId: string, actorId: string | undefined): Promise<Record<string, unknown>> {
    return this._withTransaction(
      async (session) => {
        const purchase: PurchaseDocument | null = session
          ? await Purchase.findById(purchaseId).session(session)
          : await Purchase.findById(purchaseId);
        if (!purchase) throw createStatusError('Purchase not found', 404);
        purchaseState.assert(
          'receive',
          purchase.status,
          createStatusError,
          'Only draft or approved purchases can be received',
        );

        if (purchase.status === PurchaseStatus.DRAFT) {
          purchase.status = PurchaseStatus.APPROVED;
          purchase.approvedBy = actorId as unknown as mongoose.Types.ObjectId;
          purchase.approvedAt = new Date();
          purchase.statusHistory.push(
            buildStatusEntry(
              PurchaseStatus.APPROVED,
              actorId,
              'Purchase approved',
            ) as unknown as IPurchase['statusHistory'][0],
          );
        }

        const supplier: SupplierDocument | null = purchase.supplier
          ? ((await supplierRepository.getById(purchase.supplier, { lean: true })) as SupplierDocument | null)
          : null;

        const receiveResult = await purchaseEntryService.recordPurchase(
          {
            items: purchase.items.map((item) => ({
              productId: String(item.product),
              variantSku: item.variantSku,
              quantity: item.quantity,
              costPrice: item.costPrice,
            })),
            branchId: String(purchase.branch),
            purchaseOrderNumber: purchase.purchaseOrderNumber,
            supplierName: supplier?.name,
            supplierInvoice: purchase.invoiceNumber,
            notes: purchase.notes,
            createTransaction: false,
            purchaseId: String(purchase._id),
          },
          String(actorId),
          { session, emitEvents: !session },
        );

        if (receiveResult?.errors?.length) {
          throw createStatusError('Purchase receipt failed for one or more items');
        }

        purchase.status = PurchaseStatus.RECEIVED;
        purchase.receivedBy = actorId as unknown as mongoose.Types.ObjectId;
        purchase.receivedAt = new Date();
        purchase.updatedBy = actorId as unknown as mongoose.Types.ObjectId;
        purchase.statusHistory.push(
          buildStatusEntry(
            PurchaseStatus.RECEIVED,
            actorId,
            'Purchase received',
          ) as unknown as IPurchase['statusHistory'][0],
        );

        if (session) {
          await purchase.save({ session });
        } else {
          await purchase.save();
        }

        return purchase.toObject() as unknown as Record<string, unknown>;
      },
      {
        onCommit: async (purchase: Record<string, unknown>) => {
          notifyEvent.purchaseReceived({
            purchaseId: String(purchase._id),
            invoiceNumber: String(purchase.invoiceNumber || ''),
            organizationId: String(purchase.branch || ''),
            triggeredBy: actorId,
          });

          const items = purchase?.items as Array<{ product: string | { toString(): string } }> | undefined;
          if (!items?.length) return;
          for (const item of items) {
            posLookupService.invalidateCacheForProduct(item.product);
          }
        },
      },
    );
  }

  async cancelPurchase(purchaseId: string, actorId: string | undefined, reason?: string): Promise<IPurchase | null> {
    const purchase = (await purchaseRepository.getById(purchaseId, { lean: true })) as
      | (IPurchase & { _id: string })
      | null;
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert(
      'cancel',
      purchase.status,
      createStatusError,
      'Only draft or approved purchases can be cancelled',
    );

    return purchaseRepository.appendStatus(
      purchaseId,
      buildStatusEntry(PurchaseStatus.CANCELLED, actorId, reason || 'Purchase cancelled') as unknown as IStatusHistory,
      {
        status: PurchaseStatus.CANCELLED,
        updatedBy: actorId,
      },
    );
  }

  async payPurchase(
    purchaseId: string,
    paymentData: PaymentData = {},
    actorId: string | undefined,
  ): Promise<IPurchase | null> {
    return this._withTransaction(async (session) => {
      const purchase: PurchaseDocument | null = session
        ? await Purchase.findById(purchaseId).session(session)
        : await Purchase.findById(purchaseId);
      if (!purchase) throw createStatusError('Purchase not found', 404);
      purchaseState.assert('pay', purchase.status, createStatusError, 'Cancelled purchases cannot be paid');

      const amount = normalizeNumber(paymentData.amount, purchase.dueAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw createStatusError('Payment amount must be greater than zero');
      }
      if (amount > purchase.dueAmount) {
        throw createStatusError('Payment amount exceeds due amount');
      }

      const supplier: SupplierDocument | null = purchase.supplier
        ? ((await supplierRepository.getById(purchase.supplier, { lean: true })) as SupplierDocument | null)
        : null;

      // Calculate proportional tax for this payment
      const purchaseTaxTotal = normalizeNumber(purchase.taxTotal, 0);
      let paymentTax = 0;
      let taxDetails: TaxDetails | undefined;

      if (purchaseTaxTotal > 0 && purchase.grandTotal > 0) {
        const paymentRatio = amount / purchase.grandTotal;
        paymentTax = Math.round(purchaseTaxTotal * paymentRatio * 100) / 100;

        const dominantRate = purchase.items.reduce((max: number, item) => {
          return (item.taxRate || 0) > max ? item.taxRate || 0 : max;
        }, 0);

        if (dominantRate > 0) {
          taxDetails = {
            type: 'vat',
            rate: dominantRate / 100,
            isInclusive: false,
            jurisdiction: 'BD',
          };
        }
      }

      const transaction = await createVerifiedOperationalExpenseTransaction({
        amountBdt: amount,
        category: 'inventory_purchase',
        method: paymentData.method || 'cash',
        paymentDetails: {
          trxId: paymentData.reference,
          accountNumber: paymentData.accountNumber,
          walletNumber: paymentData.walletNumber,
          bankName: paymentData.bankName,
          accountName: paymentData.accountName,
          proofUrl: paymentData.proofUrl,
        },
        sourceModel: 'Purchase',
        sourceId: String(purchase._id),
        branchId: String(purchase.branch),
        source: 'api',
        metadata: {
          invoiceNumber: purchase.invoiceNumber,
          supplierId: supplier?._id?.toString?.() || null,
          supplierName: supplier?.name || null,
          purchaseTaxTotal: purchaseTaxTotal || null,
          paymentTax: paymentTax || null,
        },
        notes: [
          `Purchase payment: ${purchase.invoiceNumber}`,
          supplier?.name ? `Supplier: ${supplier.name}` : null,
          paymentData.notes,
        ]
          .filter(Boolean)
          .join('. '),
        verifiedBy: actorId,
        date: paymentData.transactionDate ? new Date(paymentData.transactionDate) : new Date(),
        taxBdt: paymentTax,
        taxDetails,
        session,
      });

      const paidAmount = normalizeNumber(purchase.paidAmount, 0) + amount;
      const payment = computePaymentStatus(purchase.grandTotal, paidAmount);

      return purchaseRepository.recordPayment(
        purchaseId,
        transaction._id,
        {
          paidAmount: payment.paidAmount,
          dueAmount: payment.dueAmount,
          paymentStatus: payment.paymentStatus,
          updatedBy: actorId,
        },
        { session },
      );
    });
  }

  private async _resolveHeadOfficeBranch(branchId?: string): Promise<BranchDocument> {
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

  private async _normalizeItems(
    items: Array<{
      productId?: string;
      variantSku?: string | null;
      quantity?: number;
      costPrice?: number;
      discount?: number;
      taxRate?: number;
      notes?: string;
    }>,
  ): Promise<Array<Record<string, unknown>>> {
    const Product = mongoose.model('Product');
    const normalized: Array<Record<string, unknown>> = [];
    const productIds: string[] = [];

    for (const item of items) {
      if (!item?.productId) {
        throw createStatusError('Product ID is required for purchase items');
      }
      productIds.push(item.productId);
    }

    const uniqueIds = [...new Set(productIds.map((id) => id.toString()))];
    const products = (await Product.find({ _id: { $in: uniqueIds } })
      .select('name sku isActive deletedAt variants')
      .lean()) as unknown as ProductDocument[];
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    for (const item of items) {
      const { productId, variantSku } = item;
      const quantity = normalizeNumber(item.quantity, 0);
      const costPrice = normalizeNumber(item.costPrice, 0);

      if (quantity < 0 || costPrice < 0) {
        throw createStatusError('Quantity and cost price must be non-negative');
      }

      const product = productMap.get(productId?.toString() || '');
      if (!product) {
        throw createStatusError(`Product not found: ${productId}`, 404);
      }

      if (variantSku) {
        const variant = (product.variants || []).find((v) => v?.sku === variantSku);
        if (!variant) {
          throw createStatusError(`Variant not found: ${variantSku}`, 404);
        }
      }

      normalized.push({
        product: productId,
        productName: product.name,
        variantSku: variantSku || null,
        quantity,
        costPrice,
        discount: normalizeNumber(item.discount, 0),
        taxRate: normalizeNumber(item.taxRate, 0),
        notes: item.notes,
      });
    }

    return normalized;
  }

  private _resolveDueDate(params: {
    paymentTerms?: string;
    creditDays?: number;
    dueDate?: string | Date | null;
    invoiceDate?: string | Date | null;
  }): Date | null {
    const { paymentTerms, creditDays, dueDate, invoiceDate } = params;
    if (paymentTerms !== PurchasePaymentTerms.CREDIT) {
      return null;
    }
    if (dueDate) return new Date(dueDate as string | Date);
    const baseDate = invoiceDate ? new Date(invoiceDate as string | Date) : new Date();
    const resolvedCreditDays = normalizeNumber(creditDays, 0);
    const next = new Date(baseDate);
    next.setDate(next.getDate() + resolvedCreditDays);
    return next;
  }
}

export default new PurchaseInvoiceService();
