/**
 * Unified Discount & Pricing Utilities
 * Single source of truth for discount calculations
 * Used by: Order, Enrollment, Subscription modules
 *
 * All functions are pure - no side effects, easy to test
 * Supports both percentage-based and fixed-amount discounts
 */

interface OrderTotals {
  subtotal?: number;
  deliveryFee?: number;
  discount?: number;
  total?: number;
  [key: string]: unknown;
}

interface OrderTotalsWithDiscount extends OrderTotals {
  discount: number;
  total: number;
}

/**
 * Calculate discounted price (percentage-based discount)
 * Used primarily for subscription plans and course pricing
 *
 * @example
 * calculateDiscountedPrice(1000, 10) // Returns 900
 * calculateDiscountedPrice(500, 25)  // Returns 375
 */
export function calculateDiscountedPrice(basePrice: number, discountPercent: number): number {
  if (!discountPercent || discountPercent === 0) return basePrice;

  const discount = (basePrice * discountPercent) / 100;
  return Math.max(0, basePrice - discount);
}

/**
 * Calculate discount amount from percentage
 *
 * @example
 * calculateDiscountAmount(1000, 10) // Returns 100
 */
export function calculateDiscountAmount(price: number, discountPercent: number): number {
  if (!discountPercent || discountPercent === 0) return 0;
  return Math.max(0, (price * discountPercent) / 100);
}

/**
 * Apply fixed discount amount to price
 * Used for order-level discounts and coupon codes
 *
 * @example
 * applyDiscountAmount(1000, 100) // Returns 900
 * applyDiscountAmount(1000, 1500) // Returns 0 (discount capped)
 */
export function applyDiscountAmount(amount: number, discountAmount: number): number {
  if (!discountAmount || discountAmount === 0) return amount;

  // Cap discount at original amount (can't be negative)
  const cappedDiscount = Math.min(discountAmount, amount);
  return Math.max(0, amount - cappedDiscount);
}

/**
 * Apply discount to order totals object
 * Used for complex order calculations with multiple components
 *
 * @example
 * applyDiscount({ subtotal: 1000, deliveryFee: 50 }, 100)
 * // Returns { subtotal: 1000, deliveryFee: 50, discount: 100, total: 950 }
 */
export function applyDiscount(totals: OrderTotals, discountAmount: number): OrderTotalsWithDiscount {
  const maxAmount = (totals.subtotal || 0) + (totals.deliveryFee || 0);

  // Cap discount at maximum possible
  const cappedDiscount = Math.min(discountAmount, maxAmount);
  const total = maxAmount - cappedDiscount;

  return {
    ...totals,
    discount: Math.max(0, cappedDiscount),
    total: Math.max(0, total),
  };
}

/**
 * Calculate percentage discount from before/after prices
 * Reverse calculation - useful for analytics
 *
 * @example
 * calculateDiscountPercentage(1000, 900) // Returns 10
 * calculateDiscountPercentage(500, 375)  // Returns 25
 */
export function calculateDiscountPercentage(originalPrice: number, discountedPrice: number): number {
  if (originalPrice === 0) return 0;

  const discountAmount = originalPrice - discountedPrice;
  return Math.max(0, (discountAmount / originalPrice) * 100);
}

/**
 * Compute item subtotal (quantity * unit price)
 * Common calculation for order items
 *
 * @example
 * computeItemSubtotal(100, 5) // Returns 500
 */
export function computeItemSubtotal(unitPrice: number, quantity: number): number {
  return Math.max(0, (unitPrice || 0) * (quantity || 1));
}

/**
 * Calculate final price with optional discount
 * Convenience function that combines base price + discount in one call
 *
 * @example
 * calculateFinalPrice(1000, 10, true)  // Returns 900 (10% off)
 * calculateFinalPrice(1000, 100, false) // Returns 900 (100 off)
 */
export function calculateFinalPrice(basePrice: number, discount: number = 0, isPercentage: boolean = true): number {
  if (!discount) return basePrice;

  if (isPercentage) {
    return calculateDiscountedPrice(basePrice, discount);
  } else {
    return applyDiscountAmount(basePrice, discount);
  }
}

/**
 * Validate discount value
 * @throws {Error} - If discount is invalid
 */
export function validateDiscount(discount: number, isPercentage: boolean = true): void {
  if (discount < 0) {
    throw new Error('Discount cannot be negative');
  }

  if (isPercentage && discount > 100) {
    throw new Error('Percentage discount cannot exceed 100%');
  }
}
