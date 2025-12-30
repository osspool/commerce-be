/**
 * Test Data Factories
 *
 * Helper functions to create test data for integration tests
 */

import jwt from 'jsonwebtoken';

export function createTestUser(app, overrides = {}) {
  const userId = overrides._id || '507f1f77bcf86cd799439011';
  const roles = overrides.roles || (overrides.role ? [overrides.role] : ['user']);
  const name = overrides.name || 'Test User';
  const email = overrides.email || 'test@example.com';
  
  const token = jwt.sign(
    { id: userId, roles, name, email },
    process.env.JWT_SECRET || 'test-secret',
    { expiresIn: '1h' }
  );

  return {
    user: {
      _id: userId,
      name,
      email,
      roles,
      ...overrides
    },
    token
  };
}

export function createTestProduct(overrides = {}) {
  const uniqueSku = `TEST-PROD-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const uniqueBarcode = `BAR-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    name: 'Test Product',
    basePrice: 1000,
    quantity: 100,
    sku: uniqueSku,
    barcode: uniqueBarcode,
    category: 'test-category',
    isActive: true,
    ...overrides,
  };
}

/**
 * Create test product with NEW explicit variants structure
 * Backend auto-generates variants from variationAttributes
 */
export function createTestProductWithExplicitVariants(overrides = {}) {
  const uniqueSku = `TEST-VAR-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    name: 'Test Explicit Variant Product',
    basePrice: 500,
    costPrice: 250,
    quantity: 0,
    category: 'test-category',
    isActive: true,
    sku: uniqueSku,
    variationAttributes: [
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Color', values: ['Red', 'Blue'] },
    ],
    // Optional: Initial variant overrides (priceModifiers, costPrices)
    variants: [
      { attributes: { size: 'l', color: 'red' }, priceModifier: 50 },
      { attributes: { size: 'l', color: 'blue' }, priceModifier: 50 },
    ],
    ...overrides,
  };
}

/**
 * Create stock entries for a product with explicit variants
 */
export async function createTestStockForVariants(app, { product, branch, quantities = {} }) {
  const StockEntry = mongoose.models.StockEntry;
  const entries = [];

  // Simple product stock (no variants)
  if (!product.variants?.length) {
    const stock = await StockEntry.create({
      product: product._id,
      branch,
      variantSku: null,
      quantity: quantities.default || 50,
      reorderPoint: 10,
      costPrice: product.costPrice || 500,
      isActive: true,
    });
    entries.push(stock);
    return entries;
  }

  // Variant stock
  for (const variant of product.variants) {
    const stock = await StockEntry.create({
      product: product._id,
      branch,
      variantSku: variant.sku,
      quantity: quantities[variant.sku] || 20,
      reorderPoint: 5,
      costPrice: variant.costPrice || product.costPrice || 500,
      isActive: variant.isActive !== false,
    });
    entries.push(stock);
  }

  return entries;
}

export function createTestBranch(overrides = {}) {
  return {
    code: 'TEST-BRANCH',
    name: 'Test Branch',
    isActive: true,
    isDefault: true,
    ...overrides,
  };
}

export function createTestStockEntry(productId, branchId, overrides = {}) {
  return {
    product: productId,
    branch: branchId,
    variantSku: null,
    quantity: 50,
    costPrice: 500,
    reorderPoint: 10,
    ...overrides,
  };
}

import mongoose from 'mongoose';

export async function createTestStock(app, { product, branch, quantity, variantSku = null }) {
  // Use mongoose directly if app.mongo.models is not available
  const StockEntry = mongoose.models.StockEntry;
  const stock = await StockEntry.create({
    product,
    branch,
    variantSku,
    quantity,
    reorderPoint: 10,
    costPrice: 500
  });
  return stock;
}

export function createTestOrder(customerId, productId, overrides = {}) {
  return {
    customer: customerId,
    customerName: 'John Doe',
    customerPhone: '01712345678',
    customerEmail: 'john@example.com',
    items: [
      {
        product: productId,
        productName: 'Test Product',
        variantSku: null,
        quantity: 2,
        price: 1000,
        costPriceAtSale: 500,
      },
    ],
    subtotal: 2000,
    discountAmount: 0,
    totalAmount: 2000,
    delivery: {
      method: 'standard',
      price: 60,
    },
    deliveryAddress: {
      recipientName: 'John Doe',
      recipientPhone: '01712345678',
      addressLine1: 'House 12, Road 5',
      addressLine2: 'Mohammadpur',
      areaId: 1,
      areaName: 'Mohammadpur',
      zoneId: 1, // Zone ID for pricing (1-6)
      providerAreaIds: {
        redx: 1,
        pathao: 101,
      },
      city: 'Dhaka',
      division: 'Dhaka',
      postalCode: '1207',
      country: 'Bangladesh',
    },
    status: 'pending',
    source: 'web',
    currentPayment: {
      method: 'bkash',
      amount: 200000,
      status: 'pending',
      reference: 'TRX123456',
    },
    ...overrides,
  };
}

// Note: createTestShipment removed - shipping data is now embedded in Order.shipping
// Use createTestOrder with shipping override instead

export function createTestCustomer(overrides = {}) {
  return {
    name: 'John Doe',
    email: 'john@example.com',
    phone: '01712345678',
    addresses: [
      {
        label: 'Home',
        recipientPhone: '01712345678',
        addressLine1: 'House 12, Road 5',
        addressLine2: 'Mohammadpur',
        areaId: 1,
        areaName: 'Mohammadpur',
        zoneId: 1,
        providerAreaIds: { redx: 1 },
        city: 'Dhaka',
        division: 'Dhaka',
        postalCode: '1207',
        country: 'Bangladesh',
        isDefault: true,
      },
    ],
    ...overrides,
  };
}

/**
 * Create a gift order where recipient differs from customer
 */
export function createTestGiftOrder(customerId, productId, overrides = {}) {
  return {
    customer: customerId,
    customerName: 'Jane Smith',
    customerPhone: '01798765432',
    customerEmail: 'jane@example.com',
    items: [
      {
        product: productId,
        productName: 'Gift Product',
        variantSku: null,
        quantity: 1,
        price: 1500,
        costPriceAtSale: 800,
      },
    ],
    subtotal: 1500,
    discountAmount: 0,
    totalAmount: 1500,
    isGift: true,
    delivery: {
      method: 'standard',
      price: 60,
    },
    // Recipient is different from customer
    deliveryAddress: {
      recipientName: 'John Doe', // Gift recipient
      recipientPhone: '01712345678', // Recipient phone
      addressLine1: 'House 99, Road 10',
      addressLine2: 'Dhanmondi',
      areaId: 2,
      areaName: 'Dhanmondi',
      zoneId: 1,
      providerAreaIds: {
        redx: 2,
        pathao: 102,
      },
      city: 'Dhaka',
      division: 'Dhaka',
      postalCode: '1205',
      country: 'Bangladesh',
    },
    status: 'pending',
    source: 'web',
    currentPayment: {
      method: 'bkash',
      amount: 156000,
      status: 'pending',
      reference: 'GIFT-TRX123',
    },
    notes: 'Gift order - please wrap nicely',
    ...overrides,
  };
}

export function createRedXWebhookPayload(trackingId, status, overrides = {}) {
  return {
    tracking_number: trackingId,
    status: status, // redx status (e.g., 'delivered', 'ready-for-delivery')
    message_en: `Shipment ${status}`,
    message_bn: `শিপমেন্ট ${status}`,
    timestamp: new Date().toISOString(),
    invoice_number: 'ORD-123',
    ...overrides,
  };
}
