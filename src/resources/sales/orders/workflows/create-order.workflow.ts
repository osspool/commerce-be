/**
 * Create Order Workflow
 *
 * E-commerce checkout flow:
 * 1. Build order items and calculate prices
 * 2. Evaluate promotions (auto + code-triggered via @classytic/promo)
 * 3. Reserve stock (web orders)
 * 4. Create order (status: pending)
 * 5. Create transaction (via revenue library)
 * 6. Apply membership points
 *
 * Migrated to Arc 2.4.0 withCompensation
 *
 * NOTE: Inventory is NOT decremented at checkout (web).
 * For POS: Use pos.controller.js which decrements immediately.
 */

import { withCompensation } from '@classytic/arc/utils';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import orderRepository from '../order.repository.js';
import { getPromoEngine } from '#resources/promotions/promo.plugin.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import { branchRepository } from '#resources/commerce/branch/index.js';
import { stockService } from '#resources/commerce/core/index.js';
import platformRepository from '#resources/platform/platform.repository.js';
import {
  calculatePointsForOrder,
  getTierDiscountPercent,
  getMemberForCustomer,
  syncCustomerMembership,
} from '../../loyalty/loyalty.bridge.js';
import { getLoyaltyEngine } from '../../loyalty/loyalty.plugin.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../order.enums.js';
import Transaction from '#resources/transaction/transaction.model.js';
import { getBatchCostPrices } from '../order.utils.js';
import { calculateOrderParcelMetrics } from '../checkout.utils.js';
import { calculateLineVatAmount, calculateOrderVat, getProductVatRate, getVatConfig } from '../vat.utils.js';
import { generateVatInvoiceForBranch } from '../vatInvoice.service.js';
import {
  toSmallestUnit,
  InvalidAmountError,
  ProviderError,
  PaymentIntentCreationError,
  RevenueError,
} from '@classytic/revenue';

import logger from '#lib/utils/logger.js';

import type { OrderDocument } from '../order.model.js';

interface StatusError extends Error {
  statusCode?: number;
  code?: string;
  originalError?: unknown;
}

interface WorkflowResult {
  order: OrderDocument;
  transaction: Record<string, unknown> | null;
  paymentIntent: unknown;
}

/**
 * Calculate item price with variant modifiers
 */
function getItemPrice(product: Record<string, unknown>, variantSku: string | null = null): number {
  const basePrice = (product.currentPrice || product.basePrice) as number;

  if (!variantSku || !product.variants) return basePrice;

  const variants = product.variants as Array<Record<string, unknown>>;
  const variant = variants.find((v) => v.sku === variantSku);
  return basePrice + ((variant?.priceModifier as number) || 0);
}

/**
 * Build order items from cart
 */
async function buildOrderItems(
  cartItems: Array<Record<string, unknown>>,
  branchId: string | null = null,
): Promise<{
  items: Array<Record<string, unknown>>;
  subtotal: number;
  vatInputs: Array<Record<string, unknown>>;
  vatConfig: Record<string, unknown>;
}> {
  if (!cartItems?.length) {
    throw Object.assign(new Error('Cart is empty'), { statusCode: 400 });
  }

  const vatConfig = await getVatConfig();
  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;

  const costLookupItems: Array<{ productId: string; variantSku: string | null; branchId: string | null }> = [];
  const tempItems: Array<Record<string, unknown>> = [];

  for (const cartItem of cartItems) {
    const product = cartItem.product as Record<string, unknown>;
    if (!product) {
      throw Object.assign(new Error('Invalid cart item: product not found'), { statusCode: 400 });
    }

    const variantSku = (cartItem.variantSku as string) || null;
    const price = getItemPrice(product, variantSku);

    const variants = product.variants as Array<Record<string, unknown>> | undefined;
    const variant = variantSku && variants ? variants.find((v) => v.sku === variantSku) : null;

    const vatRate = await getProductVatRate({
      product,
      variantSku,
      categorySlug: product.category as string,
      vatConfig,
    });

    tempItems.push({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      variantSku,
      variantAttributes: variant?.attributes,
      variantPriceModifier: variant?.priceModifier,
      quantity: cartItem.quantity,
      price,
      category: product.category,
      vatRate,
    });

    costLookupItems.push({
      productId: (product._id as Record<string, unknown>)?.toString?.() || String(product._id),
      variantSku,
      branchId,
    });
  }

  const costMap = await getBatchCostPrices(costLookupItems);

  const items: Array<Record<string, unknown>> = [];
  let subtotal = 0;

  for (let i = 0; i < tempItems.length; i++) {
    const item = tempItems[i];
    const lookup = costLookupItems[i];
    const costKey = `${lookup.productId}_${lookup.variantSku || 'null'}_${lookup.branchId || 'null'}`;
    const costPrice = costMap.get(costKey) || 0;

    const lineTotal = (item.price as number) * (item.quantity as number);
    subtotal += lineTotal;

    const vatAmount = calculateLineVatAmount(lineTotal, item.vatRate as number, pricesIncludeVat);

    items.push({
      product: item.product,
      productName: item.productName,
      productSlug: item.productSlug,
      variantSku: item.variantSku,
      variantAttributes: item.variantAttributes,
      variantPriceModifier: item.variantPriceModifier,
      quantity: item.quantity,
      price: item.price,
      costPriceAtSale: costPrice,
      vatRate: item.vatRate,
      vatAmount,
    });
  }

  const vatInputs = tempItems.map((item) => ({
    price: item.price as number,
    quantity: item.quantity as number,
    category: item.category as string,
    vatRate: item.vatRate as number,
  }));

  return { items, subtotal, vatInputs, vatConfig: vatConfig as unknown as Record<string, unknown> };
}

/**
 * Evaluate promotions against cart items
 */
async function evaluatePromotions(
  items: Array<Record<string, unknown>>,
  subtotal: number,
  deliveryPrice: number,
  codes: string[],
  customerId?: string,
): Promise<{
  subtotal: number;
  discount: number;
  deliveryPrice: number;
  total: number;
  evaluationId: string | null;
  promoResult: Record<string, unknown> | null;
}> {
  let discount = 0;
  let evaluationId: string | null = null;
  let promoResult: Record<string, unknown> | null = null;

  if (codes.length > 0 || true) {
    // Always evaluate — auto promos apply without codes
    const cartItems = items.map((item) => ({
      productId: String(item.product),
      sku: (item.variantSku as string) || undefined,
      categoryId: (item.category as string) || undefined,
      quantity: item.quantity as number,
      unitPrice: item.price as number,
      lineTotal: (item.price as number) * (item.quantity as number),
    }));

    const engine = getPromoEngine();
    const result = await engine.services.evaluation.evaluate(
      { items: cartItems, subtotal, codes, customerId },
      { actorId: customerId || 'anonymous' },
    );

    discount = result.totalDiscount;
    evaluationId = result.evaluationId;
    promoResult = result as unknown as Record<string, unknown>;
  }

  return {
    subtotal,
    discount,
    deliveryPrice,
    total: subtotal - discount + deliveryPrice,
    evaluationId,
    promoResult,
  };
}

/**
 * Create transaction via revenue library
 */
async function createTransaction(
  order: OrderDocument,
  customerId: string,
  paymentData: Record<string, unknown>,
  senderPhone: string | undefined,
  branchCode: string | undefined,
): Promise<{ transaction: Record<string, unknown>; paymentIntent: unknown }> {
  const revenue = getRevenue();

  const transactionPaymentData: Record<string, unknown> = {
    method: paymentData.type || 'cash',
    trxId: paymentData.reference,
    walletNumber: senderPhone || (paymentData.paymentDetails as Record<string, unknown>)?.walletNumber,
    walletType: (paymentData.paymentDetails as Record<string, unknown>)?.walletType,
    bankName: (paymentData.paymentDetails as Record<string, unknown>)?.bankName,
    accountNumber: (paymentData.paymentDetails as Record<string, unknown>)?.accountNumber,
    accountName: (paymentData.paymentDetails as Record<string, unknown>)?.accountName,
    proofUrl: (paymentData.paymentDetails as Record<string, unknown>)?.proofUrl,
  };

  const result = await (
    revenue as Record<string, unknown> as {
      monetization: {
        create: (
          opts: Record<string, unknown>,
        ) => Promise<{ transaction: Record<string, unknown>; paymentIntent: unknown }>;
      };
    }
  ).monetization.create({
    data: {
      customerId: customerId.toString(),
      sourceId: order._id,
      sourceModel: 'Order',
    },
    planKey: 'one_time',
    monetizationType: 'purchase',
    amount: order.currentPayment?.amount,
    currency: 'BDT',
    gateway: paymentData.gateway || 'manual',
    paymentData: transactionPaymentData,
    metadata: {
      orderId: order._id.toString(),
      senderPhone,
      paymentReference: paymentData.reference,
      source: 'web',
      vatInvoiceNumber: order.vat?.invoiceNumber || null,
      vatSellerBin: order.vat?.sellerBin || null,
    },
    idempotencyKey: order.idempotencyKey || `order_${order._id}`,
  });

  if (result.transaction?._id) {
    const vatAmount = order.vat?.applicable ? toSmallestUnit(order.vat.amount!, 'BDT') : 0;
    const baseUpdate: Record<string, unknown> = {
      source: 'web',
      ...(order.branch ? { branch: order.branch } : {}),
      ...(branchCode ? { branchCode } : {}),
      tax: vatAmount,
      ...(order.vat?.applicable && {
        taxDetails: {
          type: 'vat',
          rate: (order.vat.rate || 0) / 100,
          isInclusive: order.vat.pricesIncludeVat ?? true,
          jurisdiction: 'BD',
        },
      }),
    };

    const existing = await Transaction.findById(result.transaction._id).select('amount fee').lean();

    const fee = ((existing as Record<string, unknown>)?.fee as number) || 0;
    if ((existing as Record<string, unknown>)?.amount !== undefined) {
      baseUpdate.net = ((existing as Record<string, unknown>).amount as number) - fee - (vatAmount as number);
    }

    await Transaction.findByIdAndUpdate(result.transaction._id, baseUpdate);
  }

  return result;
}

interface CreateOrderCtx {
  [key: string]: unknown;
  // Inputs
  orderInput: Record<string, unknown>;
  request: Record<string, unknown>;
  customerId: string;
  customer: Record<string, unknown>;
  userId: string | null;
  preferredBranch: Record<string, unknown> | null;

  // Built during steps
  items: Array<Record<string, unknown>>;
  subtotal: number;
  vatInputs: Array<Record<string, unknown>>;
  vatConfig: Record<string, unknown>;
  totals: {
    subtotal: number;
    discount: number;
    deliveryPrice: number;
    total: number;
    evaluationId: string | null;
    promoResult: Record<string, unknown> | null;
  };
  promoCommitted: boolean;
  reservation: { reservationId: string; expiresAt: unknown } | null;
  order: OrderDocument | null;
  transaction: Record<string, unknown> | null;
  paymentIntent: unknown;
  isFreeOrder: boolean;

  // Loyalty redemption
  redemptionReservationId: string | null;
  actualPointsRedeemed: number;
  pointsRedemptionDiscount: number;
}

/**
 * Create Order Workflow
 */
export async function createOrderWorkflow(
  orderInput: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<WorkflowResult> {
  const { request } = context as { request: Record<string, unknown> };

  if (!orderInput.deliveryAddress) {
    throw new Error('Delivery address is required');
  }
  if (
    !(orderInput.delivery as Record<string, unknown>)?.method ||
    (orderInput.delivery as Record<string, unknown>)?.price === undefined
  ) {
    throw new Error('Delivery method and price are required');
  }

  // 1. Get or create customer (pre-validation, not part of compensation)
  let customer: Record<string, unknown>;
  let userId: string | null;
  if (orderInput._resolvedCustomer) {
    customer = orderInput._resolvedCustomer as Record<string, unknown>;
    userId = (orderInput._resolvedUserId as string) || null;
  } else {
    if (!request?.user) {
      throw new Error('User authentication required');
    }
    customer = (await customerRepository.linkOrCreateForUser(
      request.user as Record<string, unknown>,
    )) as unknown as Record<string, unknown>;
    userId = ((request.user as Record<string, unknown>)._id || (request.user as Record<string, unknown>).id) as string;
  }

  if (!customer) {
    throw new Error('Failed to get or create customer');
  }

  const customerId = customer._id as string;

  // 1.5. Resolve preferred branch (pure lookup)
  let preferredBranch: Record<string, unknown> | null = null;
  if (orderInput.branchSlug) {
    preferredBranch = await branchRepository.getOne({ slug: orderInput.branchSlug });
    if (!preferredBranch) {
      throw Object.assign(new Error(`Branch not found: ${orderInput.branchSlug}`), { statusCode: 400 });
    }
  } else if (orderInput.branchId) {
    preferredBranch = await branchRepository.getById(orderInput.branchId as string);
    if (!preferredBranch) {
      throw Object.assign(new Error(`Branch not found: ${orderInput.branchId}`), { statusCode: 400 });
    }
  }

  const initialCtx: CreateOrderCtx = {
    orderInput,
    request,
    customerId,
    customer,
    userId,
    preferredBranch,
    items: [],
    subtotal: 0,
    vatInputs: [],
    vatConfig: {},
    totals: { subtotal: 0, discount: 0, deliveryPrice: 0, total: 0, evaluationId: null, promoResult: null },
    promoCommitted: false,
    reservation: null,
    order: null,
    transaction: null,
    paymentIntent: null,
    isFreeOrder: false,
    redemptionReservationId: null,
    actualPointsRedeemed: 0,
    pointsRedemptionDiscount: 0,
  };

  const result = await withCompensation<CreateOrderCtx>(
    'create-order',
    [
      // Step 1: Build order items (no compensation needed — pure computation)
      {
        name: 'build-order-items',
        execute: async (ctx) => {
          const { items, subtotal, vatInputs, vatConfig } = await buildOrderItems(
            ctx.orderInput.cartItems as Array<Record<string, unknown>>,
            (ctx.preferredBranch?._id as string) || null,
          );
          ctx.items = items;
          ctx.subtotal = subtotal;
          ctx.vatInputs = vatInputs;
          ctx.vatConfig = vatConfig;

          // Validate branch stock
          const stockItems = items.map((item) => ({
            productId: String(item.product),
            variantSku: (item.variantSku as string) || null,
            quantity: item.quantity as number,
            productName: item.productName as string,
          }));
          await stockService.validate(stockItems, (ctx.preferredBranch?._id as string) || undefined);
        },
      },

      // Step 2: Evaluate promotions & calculate totals
      {
        name: 'apply-promotions',
        execute: async (ctx) => {
          const delivery = ctx.orderInput.delivery as Record<string, unknown>;

          // Normalize promo codes: support both promoCodes[] and legacy couponCode
          const promoCodes = (ctx.orderInput.promoCodes as string[]) || [];
          if (ctx.orderInput.couponCode && !promoCodes.length) {
            promoCodes.push(ctx.orderInput.couponCode as string);
          }

          ctx.totals = await evaluatePromotions(
            ctx.items,
            ctx.subtotal,
            delivery.price as number,
            promoCodes,
            ctx.customerId,
          );

          const pricesIncludeVat = (ctx.vatConfig as Record<string, unknown>).pricesIncludeVat ?? true;
          const discountRatio =
            ctx.totals.discount > 0 && ctx.totals.subtotal > 0 ? ctx.totals.discount / ctx.totals.subtotal : 0;
          if (discountRatio > 0) {
            for (const item of ctx.items) {
              const lineTotal = (item.price as number) * (item.quantity as number);
              const discountedLineTotal = lineTotal * (1 - discountRatio);
              item.vatAmount = calculateLineVatAmount(
                discountedLineTotal,
                item.vatRate as number,
                pricesIncludeVat as boolean,
              );
            }
          }

          ctx.isFreeOrder = ctx.totals.total === 0;
        },
        compensate: async (ctx) => {
          // Rollback the promo evaluation if it was created
          if (ctx.totals.evaluationId && !ctx.promoCommitted) {
            const engine = getPromoEngine();
            await engine.services.evaluation
              .rollback(ctx.totals.evaluationId, { actorId: ctx.customerId || 'system' })
              .catch((err) => { logger.warn({ err }, 'non-critical: promo evaluation rollback failed'); });
          }
        },
      },

      // Step 3: Reserve stock (web orders)
      {
        name: 'reserve-stock',
        execute: async (ctx) => {
          const stockItems = ctx.items.map((item) => ({
            productId: String(item.product),
            variantSku: (item.variantSku as string) || null,
            quantity: item.quantity as number,
            productName: item.productName as string,
          }));

          const reservationId =
            (ctx.orderInput.stockReservationId as string) ||
            (ctx.orderInput.idempotencyKey as string) ||
            `web_${ctx.userId ? ctx.userId.toString() : 'guest'}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

          ctx.reservation = await stockService.reserve(
            reservationId,
            stockItems,
            (ctx.preferredBranch?._id as string) || undefined,
          );
        },
        compensate: async (ctx) => {
          if (ctx.reservation?.reservationId) {
            await stockService.release(ctx.reservation.reservationId).catch((err) => { logger.warn({ err }, 'non-critical: stock reservation release failed'); });
          }
        },
      },

      // Step 4: Create order in DB
      {
        name: 'create-order-record',
        execute: async (ctx) => {
          const delivery = ctx.orderInput.delivery as Record<string, unknown>;
          const paymentData = (ctx.orderInput.paymentData || {}) as Record<string, unknown>;
          const paymentMethod = (paymentData.type as string) || (ctx.orderInput.paymentMethod as string) || 'cash';
          const amountInPaisa = ctx.isFreeOrder ? 0 : toSmallestUnit(ctx.totals.total, 'BDT');

          // Calculate VAT breakdown
          const vatBreakdown = (await calculateOrderVat({
            items: ctx.vatInputs as Array<{ price: number; quantity: number; category?: string; vatRate?: number }>,
            subtotal: ctx.subtotal,
            discountAmount: ctx.totals.discount,
            deliveryCharge: delivery.price as number,
          })) as unknown as Record<string, unknown>;

          if (
            vatBreakdown?.applicable &&
            (ctx.vatConfig as Record<string, unknown>).invoice &&
            ((ctx.vatConfig as Record<string, unknown>).invoice as Record<string, unknown>)?.showVatBreakdown &&
            ctx.preferredBranch?._id
          ) {
            const issuedAt = new Date();
            const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({
              branch: ctx.preferredBranch as unknown as { _id: import('mongoose').Types.ObjectId; code: string },
              issuedAt,
            });
            vatBreakdown.invoiceNumber = invoiceNumber;
            vatBreakdown.invoiceIssuedAt = issuedAt;
            vatBreakdown.invoiceBranch = ctx.preferredBranch._id;
            vatBreakdown.invoiceDateKey = dateKey;
          }

          const parcel = calculateOrderParcelMetrics(ctx.orderInput.cartItems as Array<Record<string, unknown>>);

          ctx.order = (await orderRepository.create({
            source: ctx.orderInput.source || 'web',
            ...(ctx.preferredBranch && { branch: ctx.preferredBranch._id }),
            customer: ctx.customerId,
            customerName: ctx.customer.name,
            customerPhone: ctx.customer.phone,
            customerEmail: ctx.customer.email,
            userId: ctx.userId,
            items: ctx.items,
            subtotal: ctx.totals.subtotal,
            discountAmount: ctx.totals.discount,
            deliveryCharge: delivery.price,
            totalAmount: ctx.totals.total,
            vat: vatBreakdown,
            delivery: ctx.orderInput.delivery,
            deliveryAddress: ctx.orderInput.deliveryAddress,
            parcel,
            isGift: ctx.orderInput.isGift || false,
            promoApplied: ctx.totals.promoResult
              ? {
                  evaluationId: (ctx.totals.promoResult as any).evaluationId,
                  totalDiscount: (ctx.totals.promoResult as any).totalDiscount,
                  appliedDiscounts: (ctx.totals.promoResult as any).appliedDiscounts,
                  freeProducts: (ctx.totals.promoResult as any).freeProducts,
                  appliedCodes: (ctx.totals.promoResult as any).appliedCodes,
                  programsApplied: (ctx.totals.promoResult as any).programsApplied,
                }
              : undefined,
            status: ctx.isFreeOrder ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING,
            idempotencyKey: ctx.orderInput.idempotencyKey,
            stockReservationId: ctx.reservation?.reservationId,
            stockReservationExpiresAt: ctx.reservation?.expiresAt,
            currentPayment: {
              amount: amountInPaisa,
              status: ctx.isFreeOrder ? PAYMENT_STATUS.VERIFIED : PAYMENT_STATUS.PENDING,
              method: paymentMethod,
              reference: paymentData.reference,
              ...(ctx.isFreeOrder && { verifiedAt: new Date() }),
            },
            notes: ctx.orderInput.notes,
          })) as unknown as OrderDocument;

          // Add timeline event
          if (ctx.order?.addTimelineEvent) {
            ctx.order?.addTimelineEvent('order.created', 'Order placed', ctx.request, {
              itemCount: ctx.items.length,
              total: ctx.totals.total,
              paymentMethod,
              vatApplicable: vatBreakdown.applicable,
            });
            await ctx.order?.save();
          }

          // For free orders, commit promo evaluation here
          if (ctx.isFreeOrder && ctx.totals.evaluationId) {
            const engine = getPromoEngine();
            await engine.services.evaluation.commit(
              ctx.totals.evaluationId,
              String(ctx.order!._id),
              { actorId: ctx.customerId || 'system' },
            );
            ctx.promoCommitted = true;
          }
        },
        compensate: async (ctx) => {
          if (ctx.order) {
            await orderRepository.delete(String(ctx.order._id)).catch((err) => { logger.warn({ err }, 'non-critical: order cleanup failed during compensation'); });
          }
        },
      },

      // Step 5: Apply membership benefits + point redemption
      {
        name: 'apply-membership',
        execute: async (ctx) => {
          const membership = (ctx.customer as Record<string, unknown>).membership as
            | Record<string, unknown>
            | undefined;
          const pointsToRedeem = Number(ctx.orderInput.pointsToRedeem) || 0;

          // If user wants to redeem but has no active membership, throw (blocks order)
          if (pointsToRedeem > 0 && !membership?.isActive) {
            throw Object.assign(new Error('Active membership required for points redemption'), { statusCode: 400 });
          }

          if (!membership?.isActive) return; // No membership — skip silently

          let platformConfig: Record<string, unknown>;
          try {
            platformConfig = (await platformRepository.getConfig()) as any;
          } catch {
            return;
          }
          const mc = (platformConfig as Record<string, unknown>).membership as Record<string, unknown> | undefined;
          if (!mc?.enabled) return;

          const customerTier = ((membership.tierOverride || membership.tier) as string) || '';
          const tierDiscountPercent = getTierDiscountPercent(customerTier, mc as any);
          const tierDiscountAmount =
            tierDiscountPercent > 0 ? Math.round((ctx.subtotal * tierDiscountPercent) / 100) : 0;

          const preliminaryTotal = Math.max(0, ctx.totals.total - tierDiscountAmount);

          // ── Point Redemption (atomic reservation) ──
          let actualPointsRedeemed = 0;
          let pointsRedemptionDiscount = 0;

          if (pointsToRedeem > 0) {
            const loyaltyCtx = { actorId: ctx.userId || 'web-checkout' };
            const member = await getMemberForCustomer(ctx.customerId, loyaltyCtx);
            if (!member)
              throw Object.assign(new Error('Customer not enrolled in loyalty program'), { statusCode: 400 });

            const engine = getLoyaltyEngine();
            const validation = await engine.services.redemption.validate(
              { memberId: member._id, pointsToRedeem, orderTotal: preliminaryTotal },
              loyaltyCtx,
            );
            if (!validation.valid) {
              throw Object.assign(new Error(validation.error || 'Points redemption validation failed'), {
                statusCode: 400,
              });
            }

            actualPointsRedeemed = validation.pointsToRedeem;
            pointsRedemptionDiscount = validation.discountAmount;

            // Atomic reservation — compensated on failure
            const reservation = await engine.services.redemption.reserve(
              {
                memberId: member._id,
                pointsToRedeem: actualPointsRedeemed,
                orderTotal: preliminaryTotal,
                ownerType: 'Order',
                ownerId: ctx.order?._id?.toString() || 'pending',
              },
              loyaltyCtx,
            );
            ctx.redemptionReservationId = reservation._id;
            ctx.actualPointsRedeemed = actualPointsRedeemed;
            ctx.pointsRedemptionDiscount = pointsRedemptionDiscount;
          }

          // ── Calculate final total and points earned ──
          const totalAfterRedemption = Math.max(0, preliminaryTotal - pointsRedemptionDiscount);
          const pointsEarned = calculatePointsForOrder(totalAfterRedemption, mc as any, customerTier);

          // ── Update order record ──
          const totalDiscount = tierDiscountAmount + pointsRedemptionDiscount;
          const newTotal = Math.max(0, ctx.totals.total - totalDiscount);

          ctx.order!.membershipApplied = {
            cardId: membership.cardId as string,
            tier: customerTier,
            pointsEarned,
            pointsRedeemed: actualPointsRedeemed,
            pointsRedemptionDiscount,
            tierDiscountApplied: tierDiscountAmount,
            tierDiscountPercent,
          } as any;

          if (totalDiscount > 0) {
            ctx.totals.total = newTotal;
            ctx.order!.discountAmount = ((ctx.order?.discountAmount as number) || 0) + totalDiscount;
            ctx.order!.totalAmount = newTotal;
            if (ctx.order?.currentPayment) {
              ctx.order!.currentPayment.amount = ctx.isFreeOrder ? 0 : toSmallestUnit(newTotal, 'BDT');
            }
          }

          await ctx.order?.save();
        },
        compensate: async (ctx) => {
          // Release the points reservation if order fails later
          if (ctx.redemptionReservationId) {
            try {
              const engine = getLoyaltyEngine();
              await engine.services.redemption.release(ctx.redemptionReservationId, { actorId: 'system' });
            } catch {
              /* best effort */
            }
          }
        },
      },

      // Step 6: Create transaction (skipped for free orders)
      {
        name: 'create-transaction',
        execute: async (ctx) => {
          if (ctx.isFreeOrder) return;

          const paymentData = (ctx.orderInput.paymentData || {}) as Record<string, unknown>;
          const paymentMethod = (paymentData.type as string) || (ctx.orderInput.paymentMethod as string) || 'cash';
          const normalizedPaymentData = { ...paymentData, type: paymentMethod };

          try {
            const { transaction, paymentIntent } = await createTransaction(
              ctx.order!,
              ctx.customerId.toString(),
              normalizedPaymentData,
              (normalizedPaymentData as Record<string, unknown>).senderPhone as string | undefined,
              ctx.preferredBranch?.code as string | undefined,
            );

            ctx.transaction = transaction;
            ctx.paymentIntent = paymentIntent;

            ctx.order!.currentPayment!.transactionId = transaction._id as unknown as import('mongoose').Types.ObjectId;
            ctx.order!.currentPayment!.status =
              transaction.status === 'verified' ? PAYMENT_STATUS.VERIFIED : PAYMENT_STATUS.PENDING;
            await ctx.order?.save();

            // Commit promo evaluation after successful transaction
            if (ctx.totals.evaluationId) {
              const engine = getPromoEngine();
              await engine.services.evaluation.commit(
                ctx.totals.evaluationId,
                String(ctx.order!._id),
                { actorId: ctx.customerId || 'system' },
              );
              ctx.promoCommitted = true;
            }
          } catch (error) {
            // Mark order as failed before re-throwing
            if (ctx.order) {
              ctx.order.status = ORDER_STATUS.CANCELLED;
              ctx.order.cancellationReason = 'payment_failed';
              if (ctx.order.currentPayment) {
                ctx.order.currentPayment.status = PAYMENT_STATUS.FAILED;
              }
              if (ctx.order.addTimelineEvent) {
                ctx.order.addTimelineEvent('payment.failed', 'Payment initialization failed', ctx.request, {
                  reason: (error as Error)?.message || 'Payment initialization failed',
                });
              }
              await ctx.order.save();
            }

            // Re-throw with proper error types
            if (error instanceof InvalidAmountError) {
              throw Object.assign(new Error('Invalid order amount'), { statusCode: 400, code: 'INVALID_AMOUNT' });
            }
            if (error instanceof ProviderError) {
              throw Object.assign(new Error('Payment gateway unavailable'), {
                statusCode: 503,
                code: 'PROVIDER_UNAVAILABLE',
              });
            }
            if (error instanceof PaymentIntentCreationError) {
              throw Object.assign(new Error('Failed to initialize payment'), {
                statusCode: 500,
                code: 'PAYMENT_INIT_FAILED',
              });
            }
            if (error instanceof RevenueError) {
              throw Object.assign(new Error('Payment processing error'), { statusCode: 500, code: 'PAYMENT_ERROR' });
            }
            throw error;
          }
        },
        compensate: async (ctx) => {
          // Void the transaction if it was created
          if (ctx.transaction?._id) {
            const revenue = getRevenue();
            await (revenue as Record<string, unknown> as { payments: { void: (id: string) => Promise<void> } }).payments
              .void((ctx.transaction._id as Record<string, unknown>).toString())
              .catch((err) => { logger.warn({ err }, 'non-critical: transaction void failed during compensation'); });
          }
        },
      },
    ],
    initialCtx,
  );

  if (!result.success) {
    throw result.error;
  }

  // Confirm points reservation after workflow succeeds (non-blocking)
  if (initialCtx.redemptionReservationId) {
    try {
      const engine = getLoyaltyEngine();
      await engine.services.redemption.confirm(initialCtx.redemptionReservationId, {
        actorId: initialCtx.userId || 'web-checkout',
      });
      await syncCustomerMembership(initialCtx.customerId);
    } catch (err) {
      console.warn('Failed to confirm redemption (non-blocking):', (err as Error).message);
    }
  }

  notifyEvent.orderCreated({
    orderId: String(initialCtx.order!._id),
    organizationId: String(initialCtx.order!.branch),
    orderNumber: initialCtx.order!.orderNumber || String(initialCtx.order!._id).slice(-8).toUpperCase(),
    customerName: (initialCtx.customer?.name as string) || 'Customer',
    amount: String(initialCtx.order!.totalAmount || ''),
    triggeredBy: initialCtx.userId || undefined,
  });

  return {
    order: initialCtx.order!,
    transaction: initialCtx.transaction,
    paymentIntent: initialCtx.paymentIntent,
  };
}

export default createOrderWorkflow;
