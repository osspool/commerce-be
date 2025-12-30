/**
 * RedX Validation Integration Tests
 *
 * Tests for Fix #4:
 * - Payload validation catches missing required fields
 * - Descriptive errors show exactly what's missing
 * - Validation includes order context for debugging
 * - All required RedX fields are validated
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { RedXProvider } from '@classytic/bd-logistics/providers';
import Order from '../../modules/sales/orders/order.model.js';
import Customer from '../../modules/sales/customers/customer.model.js';
import Product from '../../modules/catalog/products/product.model.js';
import { createTestCustomer, createTestProduct, createTestOrder } from '../helpers/test-data.js';
import { mockRedXApi } from '../helpers/test-utils.js';

const MONGO_URI = process.env.MONGO_URI;

describe('RedX Provider - Payload Validation', () => {
  let redxProvider;
  let customer;
  let redxMock;

  beforeAll(async () => {
    if (!MONGO_URI) throw new Error('MONGO_URI is not set (expected from tests/setup/global-setup.js)');
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
    }
  });

  afterAll(async () => {
    // Global teardown closes the connection
  });

  beforeEach(() => {
    redxProvider = new RedXProvider({
      apiUrl: 'https://sandbox.redx.com.bd/v1.0.0-beta',
      apiKey: 'test-key',
      settings: {
        defaultPickupStoreId: 123,
      },
    });

    redxMock = mockRedXApi();
  });

  afterEach(() => {
    if (redxMock) {
      redxMock.restore();
    }
  });

  describe('Required Field Validation', () => {
    it('should reject order without customer name', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: '', // Empty
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('customer_name is required');
    });

    it('should reject order without customer phone', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '', // Empty
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('customer_phone is required');
    });

    it('should reject order without delivery address', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: null, // Missing
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('customer_address is required');
    });

    it('should reject order without delivery area name', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: '', // Empty
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: '', // Empty
          pickupStoreId: 123,
        })
      ).rejects.toThrow('delivery_area (area name) is required');
    });

    it('should reject order without delivery area ID', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: null, // Missing
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('delivery_area_id is required');
    });

    it('should reject order without pickup store ID', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      // No pickup store ID in options or config
      const providerWithoutPickup = new RedXProvider({
        apiUrl: 'https://sandbox.redx.com.bd/v1.0.0-beta',
        apiKey: 'test-key',
        settings: {}, // No default pickup store
      });

      await expect(
        providerWithoutPickup.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: null, // Missing
        })
      ).rejects.toThrow('pickup_store_id is required');
    });

    it('should reject order without merchant invoice ID', async () => {
      const order = {
        _id: null, // Missing
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('merchant_invoice_id is required');
    });
  });

  describe('Multiple Missing Fields', () => {
    it('should list all missing fields in error message', async () => {
      const order = {
        _id: null, // Missing
        customerName: '', // Empty
        customerPhone: '', // Empty
        deliveryAddress: null, // Missing
        totalAmount: 2000,
        items: [],
      };

      const providerWithoutPickup = new RedXProvider({
        apiUrl: 'https://sandbox.redx.com.bd/v1.0.0-beta',
        apiKey: 'test-key',
        settings: {}, // No default pickup store
      });

      try {
        await providerWithoutPickup.createShipment(order, {
          deliveryAreaId: null,
          deliveryAreaName: '',
          pickupStoreId: null,
        });
        expect.fail('Should have thrown validation error');
      } catch (error) {
        // Should list all errors
        expect(error.message).toContain('customer_name is required');
        expect(error.message).toContain('customer_phone is required');
        expect(error.message).toContain('customer_address is required');
        expect(error.message).toContain('delivery_area');
        expect(error.message).toContain('delivery_area_id is required');
        expect(error.message).toContain('merchant_invoice_id is required');
        expect(error.message).toContain('pickup_store_id is required');
      }
    });

    it('should include order details in error details', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          // Missing areaId and areaName
        },
        totalAmount: 2000,
        items: [],
      };

      try {
        await redxProvider.createShipment(order, {
          deliveryAreaId: null,
          deliveryAreaName: '',
        });
        expect.fail('Should have thrown validation error');
      } catch (error) {
        // Should include validation errors in message
        expect(error.message).toContain('Shipment validation failed');
        expect(error.message).toContain('delivery_area');

        // Should have error details with context
        expect(error.details).toBeDefined();
        expect(error.details.context).toBeDefined();
        expect(error.details.context.orderId).toBe(order._id.toString());
        expect(error.details.context.customerName).toBe('John Doe');
        expect(error.details.context.customerPhone).toBe('01712345678');
      }
    });
  });

  describe('Valid Order Processing', () => {
    it('should accept order with all required fields', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12, Road 5',
          addressLine2: 'Mohammadpur',
          areaId: 1,
          areaName: 'Mohammadpur',
          city: 'Dhaka',
        },
        totalAmount: 2000,
        items: [
          {
            productName: 'Test Product',
            quantity: 2,
            price: 1000,
          },
        ],
      };

      // Should not throw
      const result = await redxProvider.createShipment(order, {
        deliveryAreaId: 1,
        deliveryAreaName: 'Mohammadpur',
        pickupStoreId: 123,
        cashCollectionAmount: 2000,
      });

      expect(result).toBeDefined();
      expect(result.trackingId).toBeDefined();
    });

    it('should use default pickup store from config if not provided', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: 'John Doe',
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12, Road 5',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      // Don't provide pickupStoreId - should use default from config
      const result = await redxProvider.createShipment(order, {
        deliveryAreaId: 1,
        deliveryAreaName: 'Mohammadpur',
        // pickupStoreId: not provided - should use default (123)
      });

      expect(result).toBeDefined();
    });

    it('should accept order with deliveryAddress.name fallback', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: '', // Empty - should use deliveryAddress.name
        deliveryAddress: {
          name: 'Jane Doe', // Fallback name
          phone: '01798765432', // Fallback phone
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        customerPhone: '', // Empty
        totalAmount: 2000,
        items: [],
      };

      // Should not throw - uses fallback fields
      const result = await redxProvider.createShipment(order, {
        deliveryAreaId: 1,
        deliveryAreaName: 'Mohammadpur',
        pickupStoreId: 123,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Field Trimming', () => {
    it('should reject fields with only whitespace', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: '   ', // Only whitespace
        customerPhone: '01712345678',
        deliveryAddress: {
          addressLine1: 'House 12',
          areaId: 1,
          areaName: 'Mohammadpur',
        },
        totalAmount: 2000,
        items: [],
      };

      await expect(
        redxProvider.createShipment(order, {
          deliveryAreaId: 1,
          deliveryAreaName: 'Mohammadpur',
          pickupStoreId: 123,
        })
      ).rejects.toThrow('customer_name is required');
    });

    it('should accept trimmed valid fields', async () => {
      const order = {
        _id: new mongoose.Types.ObjectId(),
        customerName: '  John Doe  ', // Has whitespace but valid
        customerPhone: '  01712345678  ',
        deliveryAddress: {
          addressLine1: '  House 12  ',
          areaId: 1,
          areaName: '  Mohammadpur  ',
        },
        totalAmount: 2000,
        items: [],
      };

      // Should not throw
      const result = await redxProvider.createShipment(order, {
        deliveryAreaId: 1,
        deliveryAreaName: '  Mohammadpur  ',
        pickupStoreId: 123,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Integration with Full Order Model', () => {
    let product;

    beforeEach(async () => {
      // Clear collections to avoid duplicate key errors
      await Customer.deleteMany({});
      await Product.deleteMany({});
      await Order.deleteMany({});

      customer = await Customer.create(createTestCustomer());
      product = await Product.create(createTestProduct());
    });

    it('should validate real order with missing area data', async () => {
      const order = await Order.create(createTestOrder(customer._id, product._id, {
        deliveryAddress: {
          addressLine1: 'House 12',
          city: 'Dhaka',
          phone: '01712345678',
          // Missing areaId and areaName
        },
      }));

      await expect(
        redxProvider.createShipment(order, {
          // Options don't provide area data either
          pickupStoreId: 123,
        })
      ).rejects.toThrow('delivery_area');
    });

    it('should accept real order with complete area data', async () => {
      const order = await Order.create(createTestOrder(customer._id, product._id));

      // Should not throw
      const result = await redxProvider.createShipment(order, {
        deliveryAreaId: order.deliveryAddress.areaId,
        deliveryAreaName: order.deliveryAddress.areaName,
        pickupStoreId: 123,
        cashCollectionAmount: order.totalAmount,
      });

      expect(result).toBeDefined();
      expect(result.trackingId).toBeDefined();
    });
  });
});
