/**
 * Unified Discount & Pricing Utilities
 * Single source of truth for discount calculations
 * Used by: Order, Enrollment, Subscription modules
 *
 * All functions are pure - no side effects, easy to test
 * Supports both percentage-based and fixed-amount discounts
 */

/**
 * Calculate discounted price (percentage-based discount)
 * Used primarily for subscription plans and course pricing
 *
 * @param {Number} basePrice - Original price
 * @param {Number} discountPercent - Discount percentage (0-100)
 * @returns {Number} - Final price after discount (never negative)
 *
 * @example
 * calculateDiscountedPrice(1000, 10) // Returns 900
 * calculateDiscountedPrice(500, 25)  // Returns 375
 */
export function calculateDiscountedPrice(basePrice, discountPercent) {
  if (!discountPercent || discountPercent === 0) return basePrice;

  const discount = (basePrice * discountPercent) / 100;
  return Math.max(0, basePrice - discount);
}

/**
 * Calculate discount amount from percentage
 * @param {Number} price - Base price
 * @param {Number} discountPercent - Discount percentage (0-100)
 * @returns {Number} - Discount amount
 *
 * @example
 * calculateDiscountAmount(1000, 10) // Returns 100
 */
export function calculateDiscountAmount(price, discountPercent) {
  if (!discountPercent || discountPercent === 0) return 0;
  return Math.max(0, (price * discountPercent) / 100);
}

/**
 * Apply fixed discount amount to price
 * Used for order-level discounts and coupon codes
 *
 * @param {Number} amount - Original amount
 * @param {Number} discountAmount - Fixed discount amount
 * @returns {Number} - Final amount after discount (never negative, capped at original amount)
 *
 * @example
 * applyDiscountAmount(1000, 100) // Returns 900
 * applyDiscountAmount(1000, 1500) // Returns 0 (discount capped)
 */
export function applyDiscountAmount(amount, discountAmount) {
  if (!discountAmount || discountAmount === 0) return amount;

  // Cap discount at original amount (can't be negative)
  const cappedDiscount = Math.min(discountAmount, amount);
  return Math.max(0, amount - cappedDiscount);
}

/**
 * Apply discount to order totals object
 * Used for complex order calculations with multiple components
 *
 * @param {Object} totals - Current totals { subtotal, deliveryFee, discount?, total? }
 * @param {Number} discountAmount - Fixed discount amount to apply
 * @returns {Object} - Updated totals with discount applied
 *
 * @example
 * applyDiscount({ subtotal: 1000, deliveryFee: 50 }, 100)
 * // Returns { subtotal: 1000, deliveryFee: 50, discount: 100, total: 950 }
 */
export function applyDiscount(totals, discountAmount) {
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
 * @param {Number} originalPrice - Original price
 * @param {Number} discountedPrice - Price after discount
 * @returns {Number} - Discount percentage (0-100)
 *
 * @example
 * calculateDiscountPercentage(1000, 900) // Returns 10
 * calculateDiscountPercentage(500, 375)  // Returns 25
 */
export function calculateDiscountPercentage(originalPrice, discountedPrice) {
  if (originalPrice === 0) return 0;

  const discountAmount = originalPrice - discountedPrice;
  return Math.max(0, (discountAmount / originalPrice) * 100);
}

/**
 * Compute item subtotal (quantity * unit price)
 * Common calculation for order items
 *
 * @param {Number} unitPrice - Price per unit
 * @param {Number} quantity - Quantity
 * @returns {Number} - Subtotal (never negative)
 *
 * @example
 * computeItemSubtotal(100, 5) // Returns 500
 */
export function computeItemSubtotal(unitPrice, quantity) {
  return Math.max(0, (unitPrice || 0) * (quantity || 1));
}

/**
 * Calculate final price with optional discount
 * Convenience function that combines base price + discount in one call
 *
 * @param {Number} basePrice - Base price
 * @param {Number} discount - Discount (percentage or amount based on isPercentage flag)
 * @param {Boolean} isPercentage - True if discount is percentage, false if fixed amount
 * @returns {Number} - Final price
 *
 * @example
 * calculateFinalPrice(1000, 10, true)  // Returns 900 (10% off)
 * calculateFinalPrice(1000, 100, false) // Returns 900 (100 off)
 */
export function calculateFinalPrice(basePrice, discount = 0, isPercentage = true) {
  if (!discount) return basePrice;

  if (isPercentage) {
    return calculateDiscountedPrice(basePrice, discount);
  } else {
    return applyDiscountAmount(basePrice, discount);
  }
}

/**
 * Validate discount value
 * @param {Number} discount - Discount value
 * @param {Boolean} isPercentage - True if discount is percentage
 * @throws {Error} - If discount is invalid
 */
export function validateDiscount(discount, isPercentage = true) {
  if (discount < 0) {
    throw new Error('Discount cannot be negative');
  }

  if (isPercentage && discount > 100) {
    throw new Error('Percentage discount cannot exceed 100%');
  }
}
