import orderRepository from '../order.repository.js';
import { ORDER_STATUS, PAYMENT_STATUS, SHIPPING_STATUS } from '../order.enums.js';
import { stockTransactionService } from '#modules/inventory/index.js';
import { branchRepository } from '#modules/commerce/branch/index.js';
import { stockService } from '#modules/commerce/core/index.js';
import { getVatConfig } from '../vat.utils.js';
import { generateVatInvoiceForBranch } from '../vatInvoice.service.js';
import { createVerifiedOperationalExpenseTransaction } from '#modules/transaction/utils/operational-transactions.js';
import Transaction from '#modules/transaction/transaction.model.js';

/**
 * Fulfill Order Workflow
 *
 * Handles order fulfillment/shipping:
 * 1. Validates order state
 * 2. Decrements inventory from specified branch
 * 3. Updates shipping status
 * 4. Optionally records COGS expense transaction
 *
 * User-controlled COGS recording:
 * - recordCogs: false (default) → Only decrements stock
 * - recordCogs: true → Also creates COGS expense transaction
 *
 * Default is false because profit is already tracked in order via costPriceAtSale.
 * COGS transaction is for explicit financial ledger entries (double-entry accounting).
 *
 * FE passes branchId or branchSlug - if neither, uses default branch.
 */
export async function fulfillOrderWorkflow(orderId, options = {}) {
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

  const order = await orderRepository.getById(orderId, { lean: false });
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  if (order.status === ORDER_STATUS.CANCELLED) {
    throw new Error('Cannot fulfill a cancelled order');
  }

  if (order.status === ORDER_STATUS.DELIVERED) {
    throw new Error('Order is already delivered');
  }

  if (order.status === ORDER_STATUS.SHIPPED) {
    throw new Error('Order is already shipped');
  }

  const payment = order.currentPayment || {};
  const isCod = payment.method === 'cash';
  // Best practice: allow fulfillment for COD (payment collected at delivery).
  // Non-COD orders must be verified before fulfillment to avoid shipping unpaid orders.
  if (!isCod && ![PAYMENT_STATUS.VERIFIED, 'completed'].includes(payment.status)) {
    throw new Error('Order must be paid before fulfillment');
  }

  // Resolve branch for inventory decrement
  // Priority: explicit branchSlug/branchId > order.branch (from checkout) > default branch
  let branch = null;
  if (branchSlug) {
    branch = await branchRepository.getOne({ slug: branchSlug });
  } else if (branchId) {
    branch = await branchRepository.getById(branchId);
  } else if (order.branch) {
    // Use branch set during checkout (if any)
    branch = await branchRepository.getById(order.branch);
  } else {
    // Fall back to default branch
    branch = await branchRepository.getDefaultBranch();
  }

  if (!branch) {
    throw new Error('Branch not found');
  }

  // If the order has a reservation, fulfillment must use the reservation branch.
  if (order.stockReservationId) {
    const reservation = await stockService.getReservation(order.stockReservationId);
    if (!reservation) {
      const error = new Error('Order reservation not found (expired or missing)');
      error.statusCode = 409;
      throw error;
    }

    const reservedBranchId = reservation.branchId?.toString?.() || String(reservation.branchId);
    const requestedBranchId = branch._id?.toString?.() || String(branch._id);
    if (reservedBranchId !== requestedBranchId) {
      const reservedBranch = await branchRepository.getById(reservedBranchId);
      const error = new Error(
        `Order is reserved at branch ${reservedBranch?.code || reservedBranchId}; fulfill must use the same branch`
      );
      error.statusCode = 409;
      throw error;
    }
  }

  // Build stock items from order items
  const stockItems = order.items.map(item => ({
    productId: item.product,
    variantSku: item.variantSku || null,
    quantity: item.quantity,
    productName: item.productName,
  }));

  // If the order has a checkout reservation, commit it (consumes reservedQuantity and decrements quantity).
  // This prevents fulfillment from overselling inventory that is already reserved by other orders.
  const reference = { model: 'Order', id: order._id };
  const actorId = request?.user?._id;

  const decrementResult = order.stockReservationId
    ? await stockService.commitReservation(order.stockReservationId, reference, actorId)
    : await stockTransactionService.decrementBatch(stockItems, branch._id, reference, actorId);

  if (!decrementResult.success) {
    const error = new Error(decrementResult.error || 'Insufficient stock');
    error.statusCode = 400;
    throw error;
  }

  // VAT invoice assignment at fulfillment (for web orders where branch may be decided at fulfillment)
  const vatConfig = await getVatConfig();
  if (order.vat?.applicable && vatConfig.invoice?.showVatBreakdown && !order.vat.invoiceNumber) {
    const issuedAt = new Date();
    const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({ branch, issuedAt });
    order.vat.invoiceNumber = invoiceNumber;
    order.vat.invoiceIssuedAt = issuedAt;
    order.vat.invoiceBranch = branch._id;
    order.vat.invoiceDateKey = dateKey;
  }

  // Update order status
  const previousStatus = order.status;
  const now = new Date();

  order.status = ORDER_STATUS.SHIPPED;
  order.branch = branch._id;

  if (!order.shipping) {
    order.shipping = { history: [] };
  }

  order.shipping.status = SHIPPING_STATUS.PICKED_UP;
  order.shipping.trackingNumber = trackingNumber || order.shipping.trackingNumber;
  order.shipping.provider = carrier || order.shipping.provider;
  order.shipping.estimatedDelivery = estimatedDelivery || order.shipping.estimatedDelivery;
  order.shipping.pickedUpAt = shippedAt || now;

  order.shipping.history.push({
    status: SHIPPING_STATUS.PICKED_UP,
    note: notes || 'Order fulfilled and shipped',
    actor: request?.user?._id?.toString() || 'system',
    timestamp: now,
  });

  let eventDescription = `Order shipped from ${branch.name}`;
  if (carrier) eventDescription += ` via ${carrier}`;
  if (trackingNumber) eventDescription += ` (Tracking: ${trackingNumber})`;

  if (order.addTimelineEvent) {
    order.addTimelineEvent('order.shipped', eventDescription, request, {
      branch: { id: branch._id, code: branch.code, name: branch.name },
      trackingNumber,
      carrier,
      shippedAt: order.shipping.pickedUpAt,
      estimatedDelivery,
      notes,
    });
  }

  await order.save();

  // If a transaction exists, mirror VAT invoice info into transaction metadata (finance reporting)
  if (order.currentPayment?.transactionId) {
    await Transaction.findByIdAndUpdate(
      order.currentPayment.transactionId,
      {
        $set: {
          'metadata.vatInvoiceNumber': order.vat?.invoiceNumber || null,
          'metadata.vatSellerBin': order.vat?.sellerBin || null,
          'metadata.branch': branch._id.toString(),
          'metadata.branchCode': branch.code,
        },
      }
    ).catch(() => {});
  }

  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus: payment.status },
    result: order,
  });

  // Optionally create COGS expense transaction
  // Default: false (profit already tracked in order via costPriceAtSale)
  // Use recordCogs: true for explicit double-entry accounting
  let cogsTransaction = null;
  if (recordCogs) {
    try {
      // Calculate total cost from order items
      const totalCogs = order.items.reduce((sum, item) => {
        const itemCost = (item.costPriceAtSale || 0) * item.quantity;
        return sum + itemCost;
      }, 0);

      if (totalCogs > 0) {
        cogsTransaction = await createVerifiedOperationalExpenseTransaction({
          amountBdt: totalCogs,
          category: 'cogs',
          method: 'manual',
          sourceModel: 'Order',
          sourceId: order._id,
          branchId: branch._id,
          branchCode: branch.code,
          source: 'api',
          metadata: {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber,
            branchId: branch._id.toString(),
            branchCode: branch.code,
            itemCount: order.items.length,
            source: 'fulfillment',
          },
          notes: `COGS for order ${order.orderNumber}: ${order.items.length} items`,
          verifiedBy: request?.user?._id,
        });
      }
    } catch (cogsError) {
      // Log but don't fail - order was already fulfilled
      request?.log?.error?.({
        err: cogsError,
        orderId: order._id,
        message: 'Failed to create COGS transaction',
      });
    }
  }

  return { order, branch, cogsTransaction };
}

export default fulfillOrderWorkflow;
