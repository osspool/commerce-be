import type { FastifyRequest, FastifyReply } from 'fastify';
import logger from '#lib/utils/logger.js';
import productRepository from '#resources/catalog/products/product.repository.js';
import { stockTransactionService } from '#resources/inventory/index.js';
import { branchRepository } from '#resources/commerce/branch/index.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import orderRepository from '#resources/sales/orders/order.repository.js';
import type { OrderDocument } from '#resources/sales/orders/order.model.js';
import { fromSmallestUnit, toSmallestUnit } from '@classytic/revenue';
import platformRepository from '#resources/platform/platform.repository.js';
import { getBatchCostPrices } from '#resources/sales/orders/order.utils.js';
import { filterOrderCostPriceByUser } from '#resources/sales/orders/order.costPrice.utils.js';
import { calculateOrderParcelMetricsFromLineItems } from '#resources/sales/orders/checkout.utils.js';
import { generateVatInvoiceForBranch } from '#resources/sales/orders/vatInvoice.service.js';
import {
  calculateLineVatAmount,
  calculateOrderVat,
  getProductVatRate,
  getVatConfig,
} from '#resources/sales/orders/vat.utils.js';
import { getLoyaltyEngine } from '../loyalty/loyalty.plugin.js';
import * as loyaltyBridge from '../loyalty/loyalty.bridge.js';
import { calculatePointsForOrder, getTierDiscountPercent } from '../loyalty/loyalty.bridge.js';
import { idempotencyService } from '#resources/commerce/core/index.js';
import { createEvent } from '@classytic/arc/events';
import { outbox } from '#shared/outbox/index.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  [key: string]: unknown;
}

interface PosOrderBody {
  items: Array<{ productId: string; variantSku?: string; quantity: number; price?: number }>;
  customer?: { id?: string; name?: string; phone?: string };
  payment?: { method: string; amount: number; reference?: string; details?: unknown };
  payments?: Array<{ method: string; amount: number; reference?: string; details?: unknown }>;
  discount?: number;
  notes?: string;
  branchId?: string;
  branchSlug?: string;
  terminalId?: string;
  deliveryMethod?: string;
  deliveryAddress?: Record<string, unknown>;
  deliveryPrice?: number;
  deliveryAreaId?: number;
  idempotencyKey?: string;
  membershipCardId?: string;
  pointsToRedeem?: number;
}

/**
 * POS Controller
 *
 * Handles POS-specific operations:
 * - POS order creation (cart-free, transactional)
 * - Receipt generation
 */
class PosController {
  constructor() {
    this.createOrder = this.createOrder.bind(this);
    this.getReceipt = this.getReceipt.bind(this);
  }

  _isDiscountActive(product: Record<string, unknown>): boolean {
    const discount = product?.discount as Record<string, unknown> | undefined;
    if (!discount?.startDate || !discount?.endDate) return false;
    const now = new Date();
    return new Date(discount.startDate as string) <= now && now <= new Date(discount.endDate as string);
  }

  _getCurrentPrice(product: Record<string, unknown>): number {
    if (!product) return 0;
    const basePrice = Number(product.basePrice || 0);
    if (!this._isDiscountActive(product)) return basePrice;

    const discount = product.discount as Record<string, unknown> | undefined;
    const { type, value } = discount || {};
    const discountValue = Number(value || 0);
    if (type === 'percentage') return basePrice * (1 - discountValue / 100);
    if (type === 'fixed') return Math.max(basePrice - discountValue, 0);
    return basePrice;
  }

  _getItemPrice(product: Record<string, unknown>, variantSku: string | null = null): number {
    const base = this._getCurrentPrice(product);
    if (!variantSku || !Array.isArray(product?.variants)) return base;
    const variant = (product.variants as Array<Record<string, unknown>>).find(
      (v: Record<string, unknown>) => v?.sku === variantSku,
    );
    return base + (Number(variant?.priceModifier || 0) || 0);
  }

  /**
   * Create POS order (cart-free)
   */
  async createOrder(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const {
      items,
      customer,
      payment,
      payments: paymentsArray,
      discount = 0,
      notes,
      branchId,
      branchSlug,
      terminalId,
      deliveryMethod = 'pickup',
      deliveryAddress,
      deliveryPrice = 0,
      deliveryAreaId,
      idempotencyKey,
      membershipCardId,
      pointsToRedeem = 0,
    } = req.body as PosOrderBody;

    const payments = paymentsArray || (payment ? [payment] : undefined);

    const user = (req as unknown as { user: AuthenticatedUser }).user;
    const cashier = {
      ...user,
      _id: user._id || user.id,
      id: user.id || user._id,
    };

    const effectiveIdempotencyKey =
      idempotencyKey ||
      (idempotencyService.generateKey({
        source: 'pos',
        terminalId,
        userId: cashier._id?.toString() ?? '',
      }) as string);

    try {
      const { isNew, existingResult } = await idempotencyService.check(effectiveIdempotencyKey, {
        items,
        customer,
        payments,
        discount,
        branchId,
        branchSlug,
        terminalId,
        deliveryMethod,
        deliveryAddress,
        deliveryPrice,
        membershipCardId,
        pointsToRedeem,
        notes,
      });

      if (!isNew && existingResult) {
        return reply.code(200).send({
          success: true,
          data: existingResult,
          message: 'Order already exists (idempotent)',
          cached: true,
        });
      }

      if (!items || items.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'At least one item is required',
        });
      }

      // Resolve branch
      let branch: Record<string, unknown> | null = null;
      if (branchSlug) {
        branch = await branchRepository.getOne({ slug: branchSlug });
      } else if (branchId) {
        branch = await branchRepository.getById(branchId);
      } else {
        branch = await branchRepository.getDefaultBranch();
      }

      if (!branch) {
        return reply.code(400).send({ success: false, message: 'Invalid branch' });
      }

      // Resolve customer
      let resolvedCustomer: Record<string, unknown> | null = null;
      if (membershipCardId) {
        resolvedCustomer = (await customerRepository.lookupByCardId(membershipCardId)) as Record<
          string,
          unknown
        > | null;
        if (!resolvedCustomer) {
          return reply.code(400).send({
            success: false,
            message: `Membership card not found: ${membershipCardId}`,
          });
        }
      } else if (customer?.id || customer?.phone) {
        resolvedCustomer = (await customerRepository.resolvePosCustomer(
          { name: customer.name, phone: customer.phone },
          customer.id || null,
        )) as Record<string, unknown> | null;
      }

      // Fetch all products
      const productsMap = new Map<string, Record<string, unknown>>();
      await Promise.all(
        items.map(async (item) => {
          const product = await productRepository.getById(item.productId, { lean: true });
          if (product) {
            productsMap.set(item.productId, product as unknown as Record<string, unknown>);
          }
        }),
      );

      // Build order items and stock items
      const orderItems: Array<Record<string, unknown>> = [];
      const stockItems: Array<{ productId: string; variantSku?: string; quantity: number; productName: string }> = [];
      const costLookupItems: Array<{ productId: string; variantSku: string | null; branchId: string }> = [];
      const parcelLineItems: Array<Record<string, unknown>> = [];
      let subtotal = 0;

      for (const item of items) {
        const product = productsMap.get(item.productId);
        if (!product) {
          return reply.code(400).send({
            success: false,
            message: `Product not found: ${item.productId}`,
          });
        }

        const unitPrice = this._getItemPrice(product, item.variantSku || null);

        stockItems.push({
          productId: String(product._id),
          variantSku: item.variantSku || undefined,
          quantity: item.quantity,
          productName: product.name as string,
        });

        let variantAttributes: Record<string, unknown> | null = null;
        let variantPriceModifier = 0;
        if (item.variantSku && product.variants) {
          const variant = (product.variants as Array<Record<string, unknown>>).find(
            (v: Record<string, unknown>) => v.sku === item.variantSku,
          );
          if (variant) {
            variantAttributes = variant.attributes as Record<string, unknown>;
            variantPriceModifier = (variant.priceModifier as number) || 0;
          }
        }

        const lineTotal = unitPrice * item.quantity;
        subtotal += lineTotal;

        orderItems.push({
          product: product._id,
          productName: product.name,
          productSlug: product.slug,
          variantSku: item.variantSku,
          variantAttributes,
          variantPriceModifier,
          quantity: item.quantity,
          price: unitPrice,
        });

        costLookupItems.push({
          productId: (product._id as Record<string, unknown>)?.toString?.() || String(product._id),
          variantSku: item.variantSku || null,
          branchId: branch._id?.toString?.() || String(branch._id),
        });

        parcelLineItems.push({
          product,
          variantSku: item.variantSku || null,
          quantity: item.quantity,
        });
      }

      // Fetch cost prices
      const costMap = await getBatchCostPrices(costLookupItems);

      for (let i = 0; i < orderItems.length; i++) {
        const lookup = costLookupItems[i];
        const costKey = `${lookup.productId}_${lookup.variantSku || 'null'}_${lookup.branchId}`;
        const costPrice = costMap.get(costKey) || 0;
        orderItems[i].costPriceAtSale = costPrice;
      }

      // VAT calculation
      const vatConfig = await getVatConfig();
      const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;
      const discountAmount = discount || 0;
      const discountRatio = discountAmount > 0 && subtotal > 0 ? discountAmount / subtotal : 0;

      const vatRates = await Promise.all(
        orderItems.map((_orderItem, index) => {
          const product = productsMap.get(items[index].productId);
          return getProductVatRate({
            product: product as Record<string, unknown>,
            variantSku: items[index].variantSku || null,
            categorySlug: product?.category as string,
            vatConfig,
          });
        }),
      );

      for (let i = 0; i < orderItems.length; i++) {
        const vatRate = vatRates[i] ?? 0;
        orderItems[i].vatRate = vatRate;

        const lineTotal = (orderItems[i].price as number) * (items[i].quantity as number);
        const discountedLineTotal = discountRatio > 0 ? lineTotal * (1 - discountRatio) : lineTotal;
        orderItems[i].vatAmount = calculateLineVatAmount(discountedLineTotal, vatRate, pricesIncludeVat);
      }

      const isPickup = deliveryMethod !== 'delivery';
      const deliveryCharge = isPickup ? 0 : deliveryPrice || 0;

      // Strict validation for delivery
      if (!isPickup) {
        const recipientPhone = (deliveryAddress as Record<string, unknown>)?.recipientPhone as string;
        const recipientName = (deliveryAddress as Record<string, unknown>)?.recipientName as string;
        if (!recipientName || typeof recipientName !== 'string' || recipientName.trim().length < 2) {
          return reply
            .code(400)
            .send({ success: false, message: 'deliveryAddress.recipientName is required for delivery' });
        }
        if (!recipientPhone || typeof recipientPhone !== 'string' || !/^01[0-9]{9}$/.test(recipientPhone)) {
          return reply
            .code(400)
            .send({
              success: false,
              message: 'deliveryAddress.recipientPhone is required for delivery (format: 01XXXXXXXXX)',
            });
        }
      }

      // VAT breakdown
      const vatBreakdown = (await calculateOrderVat({
        items: orderItems.map((item, i) => ({
          price: item.price as number,
          quantity: items[i].quantity,
          category: productsMap.get(items[i].productId)?.category as string,
        })),
        subtotal,
        discountAmount,
        deliveryCharge,
      })) as unknown as Record<string, unknown>;

      if (vatBreakdown?.applicable && vatConfig.invoice?.showVatBreakdown) {
        const issuedAt = new Date();
        const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({
          branch: branch as unknown as { _id: import('mongoose').Types.ObjectId; code: string },
          issuedAt,
        });
        vatBreakdown.invoiceNumber = invoiceNumber;
        vatBreakdown.invoiceIssuedAt = issuedAt;
        vatBreakdown.invoiceBranch = branch._id;
        vatBreakdown.invoiceDateKey = dateKey;
      }

      // Membership benefits
      let membershipApplied: Record<string, unknown> | null = null;
      let tierDiscountAmount = 0;
      let pointsRedemptionDiscount = 0;
      let actualPointsRedeemed = 0;
      const platformConfig = await platformRepository.getConfig();

      const membership = resolvedCustomer?.membership as Record<string, unknown> | undefined;
      if (membership?.isActive && platformConfig.membership?.enabled) {
        const customerTier = (membership.tierOverride || membership.tier) as string;
        const tierDiscountPercent = getTierDiscountPercent(customerTier, platformConfig.membership);

        if (tierDiscountPercent > 0) {
          tierDiscountAmount = Math.round((subtotal * tierDiscountPercent) / 100);
        }

        const preliminaryTotal = Math.max(0, subtotal - discountAmount - tierDiscountAmount + deliveryCharge);

        if (pointsToRedeem > 0) {
          // Validate via loyalty engine
          const loyaltyCtx = { actorId: cashier._id?.toString() || 'pos' };
          const member = await loyaltyBridge.getMemberForCustomer(resolvedCustomer?._id as string, loyaltyCtx);
          if (!member) {
            return reply.code(400).send({ success: false, message: 'Customer not enrolled in loyalty program' });
          }

          const engine = getLoyaltyEngine();
          const validation = await engine.services.redemption.validate(
            { memberId: member._id, pointsToRedeem, orderTotal: preliminaryTotal },
            loyaltyCtx,
          );

          if (!validation.valid) {
            return reply.code(400).send({ success: false, message: validation.error });
          }

          actualPointsRedeemed = validation.pointsToRedeem;
          pointsRedemptionDiscount = validation.discountAmount;
        }

        const finalTotalForPoints = preliminaryTotal - pointsRedemptionDiscount;
        const pointsEarned = calculatePointsForOrder(finalTotalForPoints, platformConfig.membership, customerTier);

        membershipApplied = {
          cardId: membership.cardId,
          tier: customerTier,
          pointsEarned,
          pointsRedeemed: actualPointsRedeemed,
          pointsRedemptionDiscount,
          tierDiscountApplied: tierDiscountAmount,
          tierDiscountPercent,
        };
      } else if (pointsToRedeem > 0) {
        return reply.code(400).send({
          success: false,
          message: 'Active membership required for points redemption',
        });
      }

      // Atomic stock decrement
      const decrementResult = await stockTransactionService.decrementBatch(
        stockItems,
        branch._id as string,
        { model: 'Order' },
        cashier._id as string,
      );

      if (!decrementResult.success) {
        return reply.code(400).send({
          success: false,
          message: decrementResult.error || 'Insufficient stock',
        });
      }

      const didDecrement = true;

      // Atomic points reservation via loyalty engine
      let didReservePoints = false;
      let reservationId: string | null = null;
      if (actualPointsRedeemed > 0 && resolvedCustomer?._id) {
        try {
          const engine = getLoyaltyEngine();
          const loyaltyCtx = { actorId: cashier._id?.toString() || 'pos' };
          const member = await loyaltyBridge.requireMemberForCustomer(resolvedCustomer._id as string, loyaltyCtx);

          const reservation = await engine.services.redemption.reserve(
            {
              memberId: member._id,
              pointsToRedeem: actualPointsRedeemed,
              orderTotal: subtotal - discountAmount - tierDiscountAmount + deliveryCharge,
              ownerType: 'Order',
              ownerId: 'pending', // updated after order creation
            },
            loyaltyCtx,
          );
          reservationId = reservation._id;
          didReservePoints = true;
        } catch (reserveErr: any) {
          await stockTransactionService
            .restoreBatch(stockItems, branch._id as string, { model: 'Order' }, cashier._id as string)
            .catch(() => {});
          return reply.code(400).send({
            success: false,
            message: reserveErr.message || 'Failed to reserve points',
          });
        }
      }

      // Calculate totals
      const finalDiscountAmount = discountAmount + tierDiscountAmount + pointsRedemptionDiscount;
      const totalAmount = subtotal - finalDiscountAmount + deliveryCharge;
      const totalAmountInPaisa = toSmallestUnit(totalAmount, 'BDT');

      // Build payment object
      let currentPayment: Record<string, unknown>;

      if (payments && payments.length > 0) {
        const paymentsInPaisa = payments.map((p) => ({
          method: p.method,
          amount: toSmallestUnit(p.amount, 'BDT'),
          reference: p.reference || null,
          details: p.details || null,
        }));

        const paymentsTotal = paymentsInPaisa.reduce((sum, p) => sum + (p.amount as number), 0);

        if (paymentsTotal !== totalAmountInPaisa) {
          return reply.code(400).send({
            success: false,
            message: `Payments total (${fromSmallestUnit(paymentsTotal, 'BDT')}) does not match order total (${totalAmount})`,
          });
        }

        if (paymentsInPaisa.length === 1) {
          currentPayment = {
            amount: totalAmountInPaisa,
            method: paymentsInPaisa[0].method,
            reference: paymentsInPaisa[0].reference,
            status: 'verified',
            verifiedAt: new Date(),
            verifiedBy: cashier._id,
          };
        } else {
          currentPayment = {
            amount: totalAmountInPaisa,
            method: 'split',
            payments: paymentsInPaisa,
            status: 'verified',
            verifiedAt: new Date(),
            verifiedBy: cashier._id,
          };
        }
      } else {
        currentPayment = {
          amount: totalAmountInPaisa,
          method: 'cash',
          status: 'verified',
          verifiedAt: new Date(),
          verifiedBy: cashier._id,
        };
      }

      // Build delivery info
      const delivery = isPickup ? { method: 'pickup', price: 0 } : { method: 'delivery', price: deliveryCharge };

      const orderDeliveryAddress = isPickup
        ? { addressLine1: branch.name, city: (branch.address as Record<string, unknown>)?.city || '' }
        : {
            recipientName: (deliveryAddress as Record<string, unknown>)?.recipientName,
            recipientPhone: (deliveryAddress as Record<string, unknown>)?.recipientPhone,
            addressLine1:
              (deliveryAddress as Record<string, unknown>)?.addressLine1 ||
              (deliveryAddress as Record<string, unknown>)?.address ||
              '',
            addressLine2: (deliveryAddress as Record<string, unknown>)?.addressLine2 || '',
            areaName:
              (deliveryAddress as Record<string, unknown>)?.areaName ||
              (deliveryAddress as Record<string, unknown>)?.area ||
              '',
            city: (deliveryAddress as Record<string, unknown>)?.city || '',
            postalCode: (deliveryAddress as Record<string, unknown>)?.postalCode || '',
            areaId: deliveryAreaId,
          };

      const parcel = calculateOrderParcelMetricsFromLineItems(parcelLineItems as Array<Record<string, unknown>>);

      // Create order
      let order: any;
      try {
        order = await orderRepository.create({
          source: 'pos',
          branch: branch._id,
          terminalId,
          cashier: cashier._id,

          customer: resolvedCustomer?._id,
          customerName: resolvedCustomer?.name || customer?.name || 'Walk-in',
          customerPhone: resolvedCustomer?.phone || customer?.phone,

          items: orderItems,
          subtotal,
          discountAmount: finalDiscountAmount,
          deliveryCharge,
          totalAmount,

          vat: vatBreakdown,
          delivery,
          deliveryAddress: orderDeliveryAddress,
          parcel,
          membershipApplied,

          status: isPickup ? 'delivered' : 'processing',
          currentPayment,
          notes,
          idempotencyKey: effectiveIdempotencyKey,
        });
      } catch (error) {
        if (didDecrement) {
          await stockTransactionService
            .restoreBatch(stockItems, branch._id as string, { model: 'Order' }, cashier._id as string)
            .catch(() => {});
        }
        if (didReservePoints && reservationId) {
          const engine = getLoyaltyEngine();
          await engine.services.redemption
            .release(reservationId, { actorId: cashier._id?.toString() || 'pos' })
            .catch(() => {});
        }
        throw error;
      }

      // Confirm points reservation (order succeeded)
      if (didReservePoints && reservationId) {
        try {
          const engine = getLoyaltyEngine();
          await engine.services.redemption.confirm(reservationId, { actorId: cashier._id?.toString() || 'pos' });
          await loyaltyBridge.syncCustomerMembership(resolvedCustomer?._id as string);
        } catch (confirmErr) {
          logger.warn({ error: (confirmErr as Error).message, reservationId }, 'Failed to confirm redemption');
        }
      }

      // Award loyalty points via engine (non-blocking — failures logged, not thrown)
      if (membershipApplied && resolvedCustomer?._id && (membershipApplied.pointsEarned as number) > 0) {
        try {
          const engine = getLoyaltyEngine();
          const loyaltyCtx = { actorId: cashier._id?.toString() || 'pos' };
          const member = await loyaltyBridge.getMemberForCustomer(resolvedCustomer._id as string, loyaltyCtx);
          if (member) {
            await engine.services.ledger.earnPoints(
              {
                memberId: member._id,
                points: membershipApplied.pointsEarned as number,
                description: `POS order: ${order._id}`,
                referenceType: 'order',
                referenceId: (order._id as Record<string, unknown>)?.toString?.() || String(order._id),
                idempotencyKey: `pos_earn:${order._id}`,
              },
              loyaltyCtx,
            );
            await loyaltyBridge.syncCustomerMembership(resolvedCustomer._id as string);
          }
        } catch (earnErr) {
          // Non-critical: points can be awarded later via reconciliation
          logger.warn({ error: (earnErr as Error).message, orderId: order._id }, 'Failed to award loyalty points');
        }
      }

      // Mark idempotency as complete
      const safeOrder = filterOrderCostPriceByUser(order, user);
      idempotencyService.complete(effectiveIdempotencyKey, safeOrder);

      notifyEvent.orderCreated({
        orderId: String(order._id),
        organizationId: String(branch._id),
        orderNumber: order._id.toString().slice(-8).toUpperCase(),
        customerName: (resolvedCustomer?.name as string) || customer?.name || 'Walk-in',
        amount: String(totalAmount),
        triggeredBy: String(cashier._id || ''),
      });

      // Store POS transaction event in outbox for durable delivery
      const posEvent = createEvent('pos:transaction.create', {
        orderId: (order._id as Record<string, unknown>)?.toString?.() || String(order._id),
        customerId: resolvedCustomer?._id?.toString?.() || 'walk-in',
        totalAmount,
        branchId: branch._id?.toString?.() || String(branch._id),
        branchCode: branch.code,
        cashierId: cashier._id?.toString(),
        paymentMethod: currentPayment.method,
        paymentReference: currentPayment.reference,
        paymentPayments: currentPayment.payments,
        vatInvoiceNumber: (order.vat as Record<string, unknown>)?.invoiceNumber || null,
        vatSellerBin: (order.vat as Record<string, unknown>)?.sellerBin || null,
        vatApplicable: (order.vat as Record<string, unknown>)?.applicable || false,
        vatAmount: (order.vat as Record<string, unknown>)?.amount || 0,
        vatRate: (order.vat as Record<string, unknown>)?.rate || 0,
        vatPricesIncludeVat: (order.vat as Record<string, unknown>)?.pricesIncludeVat ?? true,
        terminalId,
        idempotencyKey: (order as Record<string, unknown>).idempotencyKey || `pos_${order._id}`,
      });
      await outbox.store(posEvent);

      return reply.code(201).send({
        success: true,
        data: safeOrder,
        message: 'Order created successfully',
      });
    } catch (error) {
      idempotencyService.fail(effectiveIdempotencyKey, error as Error | null);
      throw error;
    }
  }

  /**
   * Get receipt data for an order
   */
  async getReceipt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { orderId } = req.params as { orderId: string };

    const order = (await orderRepository.getById(orderId, {
      populate: [
        { path: 'branch', select: 'code name address phone' },
        { path: 'cashier', select: 'name email' },
      ],
    })) as unknown as OrderDocument | null;

    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const rawPaymentAmount = order.currentPayment?.amount;
    const paymentAmountBdt =
      rawPaymentAmount === null || rawPaymentAmount === undefined
        ? order.totalAmount || 0
        : fromSmallestUnit(rawPaymentAmount, 'BDT');

    const receipt = {
      orderId: order._id,
      orderNumber: order._id.toString().slice(-8).toUpperCase(),
      date: order.createdAt,
      status: order.status,
      invoiceNumber: order.vat?.invoiceNumber || null,

      branch: order.branch
        ? {
            name: (order.branch as any).name,
            address: (order.branch as any).address,
            phone: (order.branch as any).phone,
          }
        : null,

      cashier: (order.cashier as any)?.name || 'Staff',

      customer: {
        name: order.customerName,
        phone: order.customerPhone,
      },

      items: order.items.map((item) => ({
        name: item.productName,
        variant: item.variantAttributes
          ? Object.values(item.variantAttributes as unknown as Record<string, string>).join(', ')
          : null,
        quantity: item.quantity,
        unitPrice: item.price,
        total: item.price * item.quantity,
        vatRate: item.vatRate || 0,
        vatAmount: item.vatAmount || 0,
      })),

      subtotal: order.subtotal,
      discount: order.discountAmount,
      deliveryCharge: order.deliveryCharge || order.delivery?.price || 0,
      total: order.totalAmount,

      vat: order.vat?.applicable
        ? {
            applicable: true,
            rate: order.vat.rate,
            amount: order.vat.amount,
            taxableAmount: order.vat.taxableAmount,
            sellerBin: order.vat.sellerBin,
            pricesIncludeVat: order.vat.pricesIncludeVat,
          }
        : { applicable: false },

      delivery: {
        method: order.delivery?.method || 'pickup',
        address: order.delivery?.method === 'delivery' ? order.deliveryAddress : null,
      },

      payment: {
        method: order.currentPayment?.method || 'cash',
        amount: Math.round(paymentAmountBdt * 100) / 100,
        reference: order.currentPayment?.reference,
        payments:
          order.currentPayment?.payments?.map((p: Record<string, unknown>) => ({
            method: p.method,
            amount: fromSmallestUnit(p.amount as number, 'BDT'),
            reference: p.reference,
          })) || null,
      },

      membership: order.membershipApplied
        ? {
            cardId: order.membershipApplied.cardId,
            tier: order.membershipApplied.tier,
            pointsEarned: order.membershipApplied.pointsEarned,
            tierDiscount: order.membershipApplied.tierDiscountApplied,
          }
        : null,
    };

    return reply.send({ success: true, data: receipt });
  }
}

export default new PosController();
