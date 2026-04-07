/**
 * Fulfill Order Workflow
 *
 * Migrated to Arc 2.4.0 withCompensation
 */

import { withCompensation } from '@classytic/arc/utils';
import orderRepository from '../order.repository.js';
import { ORDER_STATUS, PAYMENT_STATUS, SHIPPING_STATUS } from '../order.enums.js';
import { stockTransactionService } from '#resources/inventory/index.js';
import { branchRepository } from '#resources/commerce/branch/index.js';
import { stockService } from '#resources/commerce/core/index.js';
import { getVatConfig } from '../vat.utils.js';
import { generateVatInvoiceForBranch } from '../vatInvoice.service.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import Transaction from '#resources/transaction/transaction.model.js';
import logger from '#lib/utils/logger.js';
import type { OrderDocument, IShipping } from '../order.model.js';

interface FulfillOptions {
  branchId?: string | null;
  branchSlug?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  notes?: string | null;
  shippedAt?: string | Date | null;
  estimatedDelivery?: string | Date | null;
  request?: Record<string, unknown> | null;
  recordCogs?: boolean;
}

interface StatusError extends Error {
  statusCode?: number;
}

interface FulfillResult {
  order: OrderDocument;
  branch: Record<string, unknown>;
  cogsTransaction: Record<string, unknown> | null;
}

interface FulfillCtx {
  [key: string]: unknown;
  order: OrderDocument;
  branch: Record<string, unknown>;
  previousStatus: string;
  previousPaymentStatus: string | undefined;
  cogsTransaction: Record<string, unknown> | null;
  decrementResult: unknown;
  vatInvoiceAssigned: boolean;
  originalVat: {
    invoiceNumber?: string;
    invoiceIssuedAt?: Date | null;
    invoiceBranch?: unknown;
    invoiceDateKey?: string | null;
  } | null;
}

/**
 * Fulfill Order Workflow
 */
export async function fulfillOrderWorkflow(orderId: string, options: FulfillOptions = {}): Promise<FulfillResult> {
  const {
    branchId = null,
    branchSlug = null,
    trackingNumber = null,
    carrier = null,
    notes = null,
    shippedAt = null,
    estimatedDelivery = null,
    request = null,
    recordCogs = false,
  } = options;

  // --- Validation (before compensation chain) ---
  const order = (await orderRepository.getById(orderId, { lean: false })) as OrderDocument;
  if (!order) {
    const error = new Error('Order not found') as StatusError;
    error.statusCode = 404;
    throw error;
  }

  if (order.status === ORDER_STATUS.CANCELLED) throw new Error('Cannot fulfill a cancelled order');
  if (order.status === ORDER_STATUS.DELIVERED) throw new Error('Order is already delivered');
  if (order.status === ORDER_STATUS.SHIPPED) throw new Error('Order is already shipped');

  const payment = order.currentPayment;
  const isCod = payment?.method === 'cash';
  if (!isCod && payment && ![PAYMENT_STATUS.VERIFIED, 'completed'].includes(payment.status)) {
    throw new Error('Order must be paid before fulfillment');
  }

  // Resolve branch (pure lookup, no compensation needed)
  let branch: Record<string, unknown> | null = null;
  if (branchSlug) {
    branch = await branchRepository.getOne({ slug: branchSlug });
  } else if (branchId) {
    branch = await branchRepository.getById(branchId);
  } else if (order.branch) {
    branch = await branchRepository.getById(String(order.branch));
  } else {
    branch = await branchRepository.getDefaultBranch();
  }

  if (!branch) throw new Error('Branch not found');

  // Reservation branch check
  if (order.stockReservationId) {
    const reservation = await stockService.getReservation(order.stockReservationId);
    if (!reservation) {
      const error = new Error('Order reservation not found (expired or missing)') as StatusError;
      error.statusCode = 409;
      throw error;
    }

    const reservedBranchId =
      (reservation as Record<string, unknown>).branchId?.toString?.() ||
      String((reservation as Record<string, unknown>).branchId);
    const requestedBranchId = String(branch._id);
    if (reservedBranchId !== requestedBranchId) {
      const reservedBranch = await branchRepository.getById(reservedBranchId);
      const error = new Error(
        `Order is reserved at branch ${reservedBranch?.code || reservedBranchId}; fulfill must use the same branch`,
      ) as StatusError;
      error.statusCode = 409;
      throw error;
    }
  }

  const previousStatus = order.status;
  const reference = { model: 'Order', id: String(order._id) };
  const actorId = (request?.user as Record<string, unknown>)?._id as string | undefined;

  const initialCtx: FulfillCtx = {
    order,
    branch,
    previousStatus,
    previousPaymentStatus: payment?.status,
    cogsTransaction: null,
    decrementResult: null,
    vatInvoiceAssigned: false,
    originalVat: order.vat
      ? {
          invoiceNumber: order.vat.invoiceNumber,
          invoiceIssuedAt: order.vat.invoiceIssuedAt,
          invoiceBranch: order.vat.invoiceBranch,
          invoiceDateKey: order.vat.invoiceDateKey,
        }
      : null,
  };

  const stockItems = order.items.map((item) => ({
    productId: String(item.product),
    variantSku: item.variantSku || null,
    quantity: item.quantity,
    productName: item.productName,
  }));

  const result = await withCompensation<FulfillCtx>(
    'fulfill-order',
    [
      // Step 1: Decrement stock
      {
        name: 'decrement-stock',
        execute: async (ctx) => {
          const decrementResult = ctx.order.stockReservationId
            ? await stockService.commitReservation(ctx.order.stockReservationId, reference, actorId as any)
            : await stockTransactionService.decrementBatch(
                stockItems as any,
                ctx.branch._id as any,
                reference,
                actorId as any,
              );

          if (!(decrementResult as unknown as Record<string, unknown>).success) {
            const error = new Error(
              ((decrementResult as unknown as Record<string, unknown>).error as string) || 'Insufficient stock',
            ) as StatusError;
            error.statusCode = 400;
            throw error;
          }

          ctx.decrementResult = decrementResult;
        },
        compensate: async (ctx) => {
          // Re-increment the stock that was decremented
          await stockTransactionService
            .restoreBatch(stockItems as any, ctx.branch._id as any, reference, actorId as any)
            .catch((err) => { logger.warn({ err }, 'non-critical: stock restore failed during compensation'); });
        },
      },

      // Step 2: Generate VAT invoice
      {
        name: 'generate-vat-invoice',
        execute: async (ctx) => {
          const vatConfig = await getVatConfig();
          if (ctx.order.vat?.applicable && vatConfig.invoice?.showVatBreakdown && !ctx.order.vat.invoiceNumber) {
            const issuedAt = new Date();
            const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({
              branch: ctx.branch as unknown as { _id: import('mongoose').Types.ObjectId; code: string },
              issuedAt,
            });
            ctx.order.vat.invoiceNumber = invoiceNumber;
            ctx.order.vat.invoiceIssuedAt = issuedAt;
            ctx.order.vat.invoiceBranch = ctx.branch._id as unknown as import('mongoose').Types.ObjectId;
            ctx.order.vat.invoiceDateKey = dateKey;
            ctx.vatInvoiceAssigned = true;
          }
        },
        compensate: async (ctx) => {
          // Restore original VAT invoice fields
          if (ctx.vatInvoiceAssigned && ctx.order.vat && ctx.originalVat) {
            ctx.order.vat.invoiceNumber = ctx.originalVat.invoiceNumber as string;
            ctx.order.vat.invoiceIssuedAt = ctx.originalVat.invoiceIssuedAt as Date;
            ctx.order.vat.invoiceBranch = ctx.originalVat.invoiceBranch as import('mongoose').Types.ObjectId;
            ctx.order.vat.invoiceDateKey = ctx.originalVat.invoiceDateKey as string;
          }
        },
      },

      // Step 3: Update shipping & order status, save
      {
        name: 'update-order-status',
        execute: async (ctx) => {
          const now = new Date();

          ctx.order.status = ORDER_STATUS.SHIPPED;
          ctx.order.branch = ctx.branch._id as unknown as import('mongoose').Types.ObjectId;

          if (!ctx.order.shipping) {
            ctx.order.shipping = { history: [] } as IShipping;
          }

          ctx.order.shipping!.status = SHIPPING_STATUS.PICKED_UP;
          ctx.order.shipping!.trackingNumber = trackingNumber || ctx.order.shipping?.trackingNumber;
          ctx.order.shipping!.provider = carrier || ctx.order.shipping?.provider;
          ctx.order.shipping!.estimatedDelivery = (
            estimatedDelivery ? new Date(estimatedDelivery as string | number) : ctx.order.shipping?.estimatedDelivery
          ) as Date | undefined;
          ctx.order.shipping!.pickedUpAt = (shippedAt ? new Date(shippedAt as string | number) : now) as
            | Date
            | undefined;

          ctx.order.shipping?.history.push({
            status: SHIPPING_STATUS.PICKED_UP,
            note: notes || 'Order fulfilled and shipped',
            actor: (request?.user as Record<string, unknown>)?._id?.toString?.() || 'system',
            timestamp: now,
          });

          let eventDescription = `Order shipped from ${ctx.branch.name}`;
          if (carrier) eventDescription += ` via ${carrier}`;
          if (trackingNumber) eventDescription += ` (Tracking: ${trackingNumber})`;

          if (ctx.order.addTimelineEvent) {
            ctx.order.addTimelineEvent('order.shipped', eventDescription, request, {
              branch: { id: ctx.branch._id, code: ctx.branch.code, name: ctx.branch.name },
              trackingNumber,
              carrier,
              shippedAt: ctx.order.shipping?.pickedUpAt,
              estimatedDelivery,
              notes,
            });
          }

          await ctx.order.save();

          orderRepository.emit('after:update', {
            context: { previousStatus: ctx.previousStatus, previousPaymentStatus: ctx.previousPaymentStatus },
            result: ctx.order,
          });
        },
        compensate: async (ctx) => {
          ctx.order.status = ctx.previousStatus as typeof ctx.order.status;
          await ctx.order.save();
        },
      },

      // Step 4: Mirror VAT info to transaction (fire-and-forget)
      {
        name: 'mirror-vat-to-transaction',
        execute: async (ctx) => {
          if (ctx.order.currentPayment?.transactionId) {
            await Transaction.findByIdAndUpdate(ctx.order.currentPayment.transactionId, {
              $set: {
                'metadata.vatInvoiceNumber': ctx.order.vat?.invoiceNumber || null,
                'metadata.vatSellerBin': ctx.order.vat?.sellerBin || null,
                'metadata.branch': String(ctx.branch._id),
                'metadata.branchCode': ctx.branch.code,
              },
            }).catch((err) => { logger.warn({ err }, 'non-critical: VAT mirror to transaction failed'); });
          }
        },
        fireAndForget: true,
      },

      // Step 5: Record COGS (fire-and-forget, optional)
      {
        name: 'record-cogs',
        execute: async (ctx) => {
          if (!recordCogs) return;

          try {
            const totalCogs = ctx.order.items.reduce((sum, item) => {
              const itemCost = (item.costPriceAtSale || 0) * item.quantity;
              return sum + itemCost;
            }, 0);

            if (totalCogs > 0) {
              ctx.cogsTransaction = await createVerifiedOperationalExpenseTransaction({
                amountBdt: totalCogs,
                category: 'cogs',
                method: 'manual',
                sourceModel: 'Order',
                sourceId: ctx.order._id as unknown as string,
                branchId: String(ctx.branch._id),
                branchCode: ctx.branch.code as string,
                source: 'api',
                metadata: {
                  orderId: ctx.order._id.toString(),
                  orderNumber: (ctx.order as unknown as Record<string, unknown>).orderNumber,
                  branchId: String(ctx.branch._id),
                  branchCode: ctx.branch.code,
                  itemCount: ctx.order.items.length,
                  source: 'fulfillment',
                },
                notes: `COGS for order ${(ctx.order as unknown as Record<string, unknown>).orderNumber}: ${ctx.order.items.length} items`,
                verifiedBy: (request?.user as Record<string, unknown>)?._id as string | undefined,
              });
            }
          } catch (cogsError) {
            ((request as Record<string, unknown>)?.log as Record<string, (...args: unknown[]) => void>)?.error?.({
              err: cogsError,
              orderId: ctx.order._id,
              message: 'Failed to create COGS transaction',
            });
          }
        },
        fireAndForget: true,
      },
    ],
    initialCtx,
  );

  if (!result.success) {
    throw result.error;
  }

  return { order: initialCtx.order, branch, cogsTransaction: initialCtx.cogsTransaction };
}

export default fulfillOrderWorkflow;
