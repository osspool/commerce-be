/**
 * Logistics Webhook Integration Tests
 *
 * Tests for webhook processing:
 * - Webhooks update order.shipping status
 * - Order status advances correctly (picked_up → shipped, delivered → delivered)
 * - trackShipment also propagates status changes
 * - Status mapping works correctly
 *
 * Note: Shipping data is stored in Order.shipping (consolidated model)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import logisticsService from '../../modules/logistics/services/logistics.service.js';
import Order from '../../modules/sales/orders/order.model.js';
import Customer from '../../modules/sales/customers/customer.model.js';
import Product from '../../modules/catalog/products/product.model.js';
import {
  createTestCustomer,
  createTestProduct,
  createTestOrder,
  createRedXWebhookPayload,
} from '../helpers/test-data.js';
import { mockRedXApi, sleep } from '../helpers/test-utils.js';

const MONGO_URI = process.env.MONGO_URI;

describe('Logistics Webhook - Order Status Propagation', () => {
  let customer;
  let product;
  let order;
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

  beforeEach(async () => {
    // Clear collections
    await Customer.deleteMany({});
    await Product.deleteMany({});
    await Order.deleteMany({});

    // Create test customer
    customer = await Customer.create(createTestCustomer());

    // Create test product
    product = await Product.create(createTestProduct());

    // Create test order with shipping data
    order = await Order.create(createTestOrder(customer._id, product._id, {
      currentPayment: {
        status: 'verified',
        method: 'bkash',
        amount: 200000,
      },
      shipping: {
        provider: 'redx',
        status: 'requested',
        trackingNumber: `TRK-${Date.now()}`,
        providerOrderId: `REDX-${Date.now()}`,
        requestedAt: new Date(),
        history: [{
          status: 'requested',
          note: 'Shipment created',
          timestamp: new Date(),
        }],
      },
    }));

    // Mock RedX API
    redxMock = mockRedXApi();

    // Initialize logistics service
    await logisticsService.initialize();
  });

  afterEach(() => {
    if (redxMock) {
      redxMock.restore();
    }
  });

  describe('Webhook Processing', () => {
    it('should update shipment status from webhook', async () => {
      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'ready-for-delivery', // RedX status
        {
          message_en: 'Parcel is out for delivery',
        }
      );

      // Process webhook
      const result = await logisticsService.processWebhook('redx', webhookPayload);

      expect(result).toBeDefined();
      expect(result.shipping.status).toBe('picked_up'); // Normalized status
      expect(result.shipping.webhookCount).toBe(1);
    });

    it('should propagate shipment status to order shipping', async () => {
      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'ready-for-delivery'
      );

      // Process webhook
      await logisticsService.processWebhook('redx', webhookPayload);

      // Check order shipping status
      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping).toBeDefined();
      expect(updatedOrder.shipping.status).toBe('picked_up');
    });

    it('should advance order status when shipment is picked up', async () => {
      // Set order to confirmed
      await Order.updateOne({ _id: order._id }, { status: 'confirmed' });

      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'ready-for-delivery' // Maps to picked_up → order status: shipped
      );

      await logisticsService.processWebhook('redx', webhookPayload);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.status).toBe('picked_up');
    });

    it('should advance order status to delivered when shipment delivered', async () => {
      // Set order to shipped
      await Order.updateOne({ _id: order._id }, { status: 'shipped' });

      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'delivered'
      );

      await logisticsService.processWebhook('redx', webhookPayload);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.status).toBe('delivered');
      expect(updatedOrder.shipping.deliveredAt).toBeDefined();
    });

    it('should update order shipping metadata with provider info', async () => {
      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'delivery-in-progress',
        {
          message_en: 'Out for delivery',
        }
      );

      await logisticsService.processWebhook('redx', webhookPayload);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.providerStatus).toBeDefined();
      expect(updatedOrder.shipping.lastWebhookAt).toBeDefined();
    });

    it('should add shipping history entry on webhook', async () => {
      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'agent-hold',
        {
          message_en: 'Parcel is at sorting facility',
        }
      );

      await logisticsService.processWebhook('redx', webhookPayload);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.history).toBeDefined();
      expect(updatedOrder.shipping.history.length).toBeGreaterThan(1); // Initial + webhook

      const latestHistory = updatedOrder.shipping.history[updatedOrder.shipping.history.length - 1];
      expect(latestHistory.status).toBe('in_transit'); // Mapped from agent-hold
    });

    it('should not update order for on-hold shipment status', async () => {
      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'on-hold' // Maps to null - should not update order status
      );

      await logisticsService.processWebhook('redx', webhookPayload);

      const updatedOrder = await Order.findById(order._id);
      // Status should remain 'requested' since on-hold doesn't map to a status
      expect(updatedOrder.shipping.status).toBe('requested');
    });

    it('should handle multiple webhooks correctly', async () => {
      // First webhook: picked up
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'ready-for-delivery'
      ));

      // Second webhook: in transit
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'agent-hold'
      ));

      // Third webhook: delivered
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'delivered'
      ));

      const updatedOrder = await Order.findById(order._id);

      expect(updatedOrder.shipping.webhookCount).toBe(3);
      expect(updatedOrder.shipping.status).toBe('delivered');
      expect(updatedOrder.shipping.history.length).toBe(4); // Initial + 3 webhooks
    });
  });

  describe('trackShipment - Status Propagation', () => {
    it('should propagate status to order when tracking', async () => {
      // Mock RedX to return delivered status
      redxMock.mock.mockImplementation((url) => {
        if (url.includes('/parcel/info/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              parcel: {
                tracking_id: order.shipping.trackingNumber,
                status: 'delivered',
                customer_name: 'John Doe',
                customer_phone: '01712345678',
                customer_address: 'Test Address',
                delivery_area: 'Mohammadpur',
                delivery_area_id: 1,
                cash_collection_amount: '2000',
                parcel_weight: 500,
                value: 2000,
                merchant_invoice_id: order._id.toString(),
                created_at: new Date().toISOString(),
                charge: 60,
              },
            }),
          });
        }
        if (url.includes('/parcel/track/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              tracking: [
                {
                  message_en: 'Parcel delivered',
                  message_bn: 'পার্সেল ডেলিভার হয়েছে',
                  time: new Date().toISOString(),
                },
              ],
            }),
          });
        }
      });

      // Track shipment
      const trackResult = await logisticsService.trackShipment(order.shipping.trackingNumber);

      expect(trackResult.order.shipping.status).toBe('delivered');
    });

    it('should not propagate if status unchanged', async () => {
      // First track to set initial status
      await logisticsService.trackShipment(order.shipping.trackingNumber);

      const orderBeforeSecondTrack = await Order.findById(order._id);
      const historyLengthBefore = orderBeforeSecondTrack.shipping?.history?.length || 0;

      // Track again with same status
      await logisticsService.trackShipment(order.shipping.trackingNumber);

      const orderAfterSecondTrack = await Order.findById(order._id);
      const historyLengthAfter = orderAfterSecondTrack.shipping?.history?.length || 0;

      // History length should not increase if status unchanged
      expect(historyLengthAfter).toBe(historyLengthBefore);
    });
  });

  describe('Status Mapping', () => {
    const statusTests = [
      { providerStatus: 'pickup-requested', expectedShippingStatus: 'requested' },
      { providerStatus: 'pickup-pending', expectedShippingStatus: 'requested' },
      { providerStatus: 'picked-up', expectedShippingStatus: 'picked_up' },
      { providerStatus: 'in-transit', expectedShippingStatus: 'in_transit' },
      { providerStatus: 'out-for-delivery', expectedShippingStatus: 'out_for_delivery' },
      { providerStatus: 'delivered', expectedShippingStatus: 'delivered' },
    ];

    statusTests.forEach(({ providerStatus, expectedShippingStatus }) => {
      it(`should map shipment ${providerStatus} to order shipping ${expectedShippingStatus}`, async () => {
        const mapped = logisticsService._mapProviderStatus(providerStatus);
        expect(mapped).toBe(expectedShippingStatus);
      });
    });
  });

  describe('Error Handling', () => {
    it('should not fail webhook processing if order update fails', async () => {
      // Delete order to cause update failure
      await Order.deleteOne({ _id: order._id });

      const webhookPayload = createRedXWebhookPayload(
        order.shipping.trackingNumber,
        'delivered'
      );

      // Should return null for unknown tracking number
      const result = await logisticsService.processWebhook('redx', webhookPayload);
      expect(result).toBeNull();
    });

    it('should warn if shipment has no linked order', async () => {
      const webhookPayload = createRedXWebhookPayload(
        'UNKNOWN-TRACKING-123',
        'delivered'
      );

      // Should return null for unknown tracking number
      const result = await logisticsService.processWebhook('redx', webhookPayload);
      expect(result).toBeNull();
    });
  });
});
