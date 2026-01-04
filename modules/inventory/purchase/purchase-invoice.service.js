import mongoose from 'mongoose';
import Purchase, { PurchaseStatus, PurchasePaymentStatus, PurchasePaymentTerms } from './models/purchase.model.js';
import purchaseRepository from './purchase.repository.js';
import supplierRepository from '../supplier/supplier.repository.js';
import branchRepository from '#modules/commerce/branch/branch.repository.js';
import purchaseEntryService from './purchase.service.js';
import inventoryRepository from '../inventory.repository.js';
import logger from '#core/utils/logger.js';
import { createVerifiedOperationalExpenseTransaction } from '#modules/transaction/utils/operational-transactions.js';
import { computePurchaseTotals, computePaymentStatus, normalizeNumber, buildStatusEntry } from './purchase.utils.js';
import { createStateMachine } from '#core/utils/state-machine.js';

function createStatusError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const purchaseState = createStateMachine('Purchase', {
  update: [PurchaseStatus.DRAFT],
  approve: [PurchaseStatus.DRAFT],
  receive: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED],
  cancel: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED],
  pay: [PurchaseStatus.DRAFT, PurchaseStatus.APPROVED, PurchaseStatus.RECEIVED],
});

class PurchaseInvoiceService {
  async _withTransaction(operation, options = {}) {
    const { onCommit } = options;
    const result = await purchaseRepository.withTransaction(
      (session) => operation(session),
      {
        allowFallback: true,
        onFallback: (error) => {
          logger.warn({ err: error }, 'Transactions not supported; falling back to non-transactional purchase flow');
        },
      }
    );

    if (onCommit) {
      await onCommit(result);
    }

    return result;
  }
  async create(data, options = {}) {
    const actorId = options.user?._id || options.context?.user?._id;
    return this.createPurchase(data, actorId);
  }

  async getAll(paginationParams = {}, options = {}) {
    return purchaseRepository.getAll(paginationParams, options);
  }

  async getById(id, options = {}) {
    return purchaseRepository.getById(id, options);
  }

  async update(id, data, options = {}) {
    const actorId = options.user?._id || options.context?.user?._id;
    return this.updateDraftPurchase(id, data, actorId);
  }

  async delete() {
    throw createStatusError('Deleting purchases is not allowed', 405);
  }

  async createPurchase(data, actorId) {
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

    const supplier = supplierId
      ? await supplierRepository.getById(supplierId, { lean: true })
      : null;

    const normalizedItems = await this._normalizeItems(items);
    const totals = computePurchaseTotals(normalizedItems);

    const resolvedPaymentTerms = paymentTerms
      || supplier?.paymentTerms
      || PurchasePaymentTerms.CASH;
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

    let purchase = await purchaseRepository.create({
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
      purchase = await this.approvePurchase(purchase._id, actorId);
    }

    if (autoReceive) {
      purchase = await this.receivePurchase(purchase._id, actorId);
    }

    if (payment) {
      purchase = await this.payPurchase(purchase._id, payment, actorId);
    }

    return purchase;
  }

  async updateDraftPurchase(purchaseId, data, actorId) {
    const purchase = await purchaseRepository.getById(purchaseId, { lean: true });
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert('update', purchase.status, createStatusError, 'Only draft purchases can be updated');

    const updates = {};
    if (data.purchaseOrderNumber !== undefined) updates.purchaseOrderNumber = data.purchaseOrderNumber;
    if (data.invoiceDate) updates.invoiceDate = new Date(data.invoiceDate);
    if (data.notes !== undefined) updates.notes = data.notes;

    if (data.supplierId) {
      const supplier = await supplierRepository.getById(data.supplierId, { lean: true });
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
        paymentTerms: updates.paymentTerms || purchase.paymentTerms,
        creditDays: updates.creditDays ?? purchase.creditDays,
        dueDate: updates.dueDate || purchase.dueDate,
        invoiceDate: updates.invoiceDate || purchase.invoiceDate,
      });
    }

    updates.updatedBy = actorId;

    return purchaseRepository.update(purchaseId, updates);
  }

  async approvePurchase(purchaseId, actorId) {
    const purchase = await purchaseRepository.getById(purchaseId, { lean: true });
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert('approve', purchase.status, createStatusError, 'Only draft purchases can be approved');

    return purchaseRepository.appendStatus(purchaseId, buildStatusEntry(
      PurchaseStatus.APPROVED,
      actorId,
      'Purchase approved'
    ), {
      status: PurchaseStatus.APPROVED,
      approvedBy: actorId,
      approvedAt: new Date(),
      updatedBy: actorId,
    });
  }

  async receivePurchase(purchaseId, actorId) {
    return this._withTransaction(async (session) => {
      const purchase = session
        ? await Purchase.findById(purchaseId).session(session)
        : await Purchase.findById(purchaseId);
      if (!purchase) throw createStatusError('Purchase not found', 404);
      purchaseState.assert('receive', purchase.status, createStatusError, 'Only draft or approved purchases can be received');

      if (purchase.status === PurchaseStatus.DRAFT) {
        purchase.status = PurchaseStatus.APPROVED;
        purchase.approvedBy = actorId;
        purchase.approvedAt = new Date();
        purchase.statusHistory.push(buildStatusEntry(
          PurchaseStatus.APPROVED,
          actorId,
          'Purchase approved'
        ));
      }

      const supplier = purchase.supplier
        ? await supplierRepository.getById(purchase.supplier, { lean: true })
        : null;

      const receiveResult = await purchaseEntryService.recordPurchase({
        items: purchase.items.map((item) => ({
          productId: item.product,
          variantSku: item.variantSku,
          quantity: item.quantity,
          costPrice: item.costPrice,
        })),
        branchId: purchase.branch,
        branchCode: purchase.branch?.code,
        purchaseOrderNumber: purchase.purchaseOrderNumber,
        supplierName: supplier?.name,
        supplierInvoice: purchase.invoiceNumber,
        notes: purchase.notes,
        createTransaction: false,
        purchaseId: purchase._id,
      }, actorId, { session, emitEvents: !session });

      if (receiveResult?.errors?.length) {
        throw createStatusError('Purchase receipt failed for one or more items');
      }

      purchase.status = PurchaseStatus.RECEIVED;
      purchase.receivedBy = actorId;
      purchase.receivedAt = new Date();
      purchase.updatedBy = actorId;
      purchase.statusHistory.push(buildStatusEntry(
        PurchaseStatus.RECEIVED,
        actorId,
        'Purchase received'
      ));

      if (session) {
        await purchase.save({ session });
      } else {
        await purchase.save();
      }

      return purchase.toObject();
    }, {
      onCommit: async (purchase) => {
        if (!purchase?.items?.length) return;
        for (const item of purchase.items) {
          await inventoryRepository.emitAsync('after:update', {
            result: { product: item.product, variantSku: item.variantSku || null },
            context: {},
          }).catch(() => {});
        }
      },
    });
  }

  async cancelPurchase(purchaseId, actorId, reason) {
    const purchase = await purchaseRepository.getById(purchaseId, { lean: true });
    if (!purchase) throw createStatusError('Purchase not found', 404);
    purchaseState.assert('cancel', purchase.status, createStatusError, 'Only draft or approved purchases can be cancelled');

    return purchaseRepository.appendStatus(purchaseId, buildStatusEntry(
      PurchaseStatus.CANCELLED,
      actorId,
      reason || 'Purchase cancelled'
    ), {
      status: PurchaseStatus.CANCELLED,
      updatedBy: actorId,
    });
  }

  async payPurchase(purchaseId, paymentData = {}, actorId) {
    return this._withTransaction(async (session) => {
      const purchase = session
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

      const supplier = purchase.supplier
        ? await supplierRepository.getById(purchase.supplier, { lean: true })
        : null;

      // Calculate proportional tax for this payment
      // For partial payments, tax is proportional to payment amount relative to grandTotal
      const purchaseTaxTotal = normalizeNumber(purchase.taxTotal, 0);
      let paymentTax = 0;
      let taxDetails = undefined;

      if (purchaseTaxTotal > 0 && purchase.grandTotal > 0) {
        const paymentRatio = amount / purchase.grandTotal;
        paymentTax = Math.round(purchaseTaxTotal * paymentRatio * 100) / 100; // Round to 2 decimal places

        // Determine dominant tax rate from items (for taxDetails)
        const dominantRate = purchase.items.reduce((max, item) => {
          return (item.taxRate || 0) > max ? (item.taxRate || 0) : max;
        }, 0);

        if (dominantRate > 0) {
          taxDetails = {
            type: 'vat',
            rate: dominantRate / 100, // Convert percentage to decimal
            isInclusive: false, // B2B purchases typically have exclusive VAT
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
        sourceId: purchase._id,
        branchId: purchase.branch,
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
        ].filter(Boolean).join('. '),
        verifiedBy: actorId,
        date: paymentData.transactionDate ? new Date(paymentData.transactionDate) : new Date(),
        // Tax data for B2B purchase (supplier VAT)
        taxBdt: paymentTax,
        taxDetails,
        session,
      });

      const paidAmount = normalizeNumber(purchase.paidAmount, 0) + amount;
      const payment = computePaymentStatus(purchase.grandTotal, paidAmount);

      return purchaseRepository.recordPayment(purchaseId, transaction._id, {
        paidAmount: payment.paidAmount,
        dueAmount: payment.dueAmount,
        paymentStatus: payment.paymentStatus,
        updatedBy: actorId,
      }, { session });
    });
  }

  async _resolveHeadOfficeBranch(branchId) {
    let branch;
    if (branchId) {
      branch = await branchRepository.Model.findById(branchId).lean();
      if (!branch) throw createStatusError('Branch not found', 404);
    } else {
      branch = await branchRepository.getHeadOffice();
    }

    if (!branch || branch.role !== 'head_office') {
      throw createStatusError('Purchases can only be recorded at head office', 403);
    }

    return branch;
  }

  async _normalizeItems(items) {
    const Product = mongoose.model('Product');
    const normalized = [];
    const productIds = [];

    for (const item of items) {
      if (!item?.productId) {
        throw createStatusError('Product ID is required for purchase items');
      }
      productIds.push(item.productId);
    }

    const uniqueIds = [...new Set(productIds.map(id => id.toString()))];
    const products = await Product.find({ _id: { $in: uniqueIds } })
      .select('name sku isActive deletedAt variants')
      .lean();
    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    for (const item of items) {
      const { productId, variantSku } = item;
      const quantity = normalizeNumber(item.quantity, 0);
      const costPrice = normalizeNumber(item.costPrice, 0);

      if (quantity < 0 || costPrice < 0) {
        throw createStatusError('Quantity and cost price must be non-negative');
      }

      const product = productMap.get(productId.toString());
      if (!product) {
        throw createStatusError(`Product not found: ${productId}`, 404);
      }

      if (variantSku) {
        const variant = (product.variants || []).find(v => v?.sku === variantSku);
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

  _resolveDueDate({ paymentTerms, creditDays, dueDate, invoiceDate }) {
    if (paymentTerms !== PurchasePaymentTerms.CREDIT) {
      return null;
    }
    if (dueDate) return new Date(dueDate);
    const baseDate = invoiceDate ? new Date(invoiceDate) : new Date();
    const resolvedCreditDays = normalizeNumber(creditDays, 0);
    const next = new Date(baseDate);
    next.setDate(next.getDate() + resolvedCreditDays);
    return next;
  }
}

export default new PurchaseInvoiceService();
