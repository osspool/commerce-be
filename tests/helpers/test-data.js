/**
 * Test Data Factories
 *
 * Helper functions to create test data for integration tests
 */

export function createTestProduct(overrides = {}) {
  return {
    name: 'Test Product',
    slug: 'test-product',
    basePrice: 1000,
    quantity: 100,
    sku: 'TEST-PROD-001',
    barcode: '1234567890',
    category: 'test-category',
    isActive: true,
    ...overrides,
  };
}

export function createTestProductWithVariants(overrides = {}) {
  return {
    name: 'Test Variant Product',
    slug: 'test-variant-product',
    basePrice: 500,
    quantity: 0, // Will be synced from variants
    category: 'test-category',
    isActive: true,
    variations: [
      {
        name: 'Size',
        options: [
          {
            value: 'Small',
            sku: 'VAR-S',
            barcode: 'BAR-S',
            priceModifier: 0,
            quantity: 50,
          },
          {
            value: 'Medium',
            sku: 'VAR-M',
            barcode: 'BAR-M',
            priceModifier: 100,
            quantity: 30,
          },
          {
            value: 'Large',
            sku: 'VAR-L',
            barcode: 'BAR-L',
            priceModifier: 200,
            quantity: 20,
          },
        ],
      },
    ],
    ...overrides,
  };
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

export function createTestShipment(orderId, overrides = {}) {
  return {
    order: orderId,
    provider: 'redx',
    trackingId: `TRK-${Date.now()}`,
    status: 'pickup-requested',
    parcel: {
      weight: 500,
      value: 2000,
      itemCount: 1,
    },
    pickup: {
      storeId: 123,
    },
    delivery: {
      customerName: 'John Doe',
      customerPhone: '01712345678',
      address: 'House 12, Road 5, Mohammadpur, Dhaka',
      areaId: 1,
      areaName: 'Mohammadpur',
    },
    cashCollection: {
      amount: 2000,
      isCod: true,
    },
    charges: {
      deliveryCharge: 60,
      codCharge: 20,
      totalCharge: 80,
    },
    timeline: [
      {
        status: 'pickup-requested',
        message: 'Shipment created',
        timestamp: new Date(),
      },
    ],
    webhookCount: 0,
    ...overrides,
  };
}

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
