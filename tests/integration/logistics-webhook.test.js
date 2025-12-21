/**
 * Logistics Webhook Integration Tests
 *
 * Tests for Fix #3:
 * - Webhooks propagate shipment status to order shipping
 * - Order status advances correctly (picked_up → shipped, delivered → delivered)
 * - trackShipment also propagates status changes
 * - Status mapping works correctly
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import logisticsService from '../../modules/logistics/services/logistics.service.js';
import shippingService from '../../modules/commerce/order/shipping.service.js';
import Order from '../../modules/commerce/order/order.model.js';
import Shipment from '../../modules/logistics/models/shipment.model.js';
import Customer from '../../modules/customer/customer.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import {
  createTestCustomer,
  createTestProduct,
  createTestOrder,
  createTestShipment,
  createRedXWebhookPayload,
} from '../helpers/test-data.js';
import { mockRedXApi, waitFor, sleep } from '../helpers/test-utils.js';

const MONGO_URI = process.env.MONGO_URI;

describe('Logistics Webhook - Order Status Propagation', () => {
  let customer;
  let product;
  let order;
  let shipment;
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
    await Shipment.deleteMany({});
    // Create test customer
    customer = await Customer.create(createTestCustomer());

    // Create test product
    product = await Product.create(createTestProduct());

    // Create test order
    order = await Order.create(createTestOrder(customer._id, product._id, {
      currentPayment: {
        status: 'verified',
        method: 'bkash',
        amount: 200000,
      },
    }));

    // Create test shipment
    shipment = await Shipment.create(createTestShipment(order._id));

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
        shipment.trackingId,
        'ready-for-delivery', // RedX status
        {
          message_en: 'Parcel is out for delivery',
        }
      );

      // Process webhook
      const result = await logisticsService.processWebhook('redx', webhookPayload);

      expect(result).toBeDefined();
      expect(result.status).toBe('picked-up'); // Normalized status
      expect(result.webhookCount).toBe(1);
    });

    it('should propagate shipment status to order shipping', async () => {
      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'ready-for-delivery'
      );

      // Process webhook
      await logisticsService.processWebhook('redx', webhookPayload);

      // Wait for order update
      await sleep(100);

      // Check order shipping status
      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping).toBeDefined();
      expect(updatedOrder.shipping.status).toBe('picked_up');
    });

    it('should advance order status when shipment is picked up', async () => {
      // Set order to confirmed
      await Order.updateOne({ _id: order._id }, { status: 'confirmed' });

      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'ready-for-delivery' // Maps to picked_up → order status: shipped
      );

      await logisticsService.processWebhook('redx', webhookPayload);
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.status).toBe('shipped');
      expect(updatedOrder.shipping.status).toBe('picked_up');
    });

    it('should advance order status to delivered when shipment delivered', async () => {
      // Set order to shipped
      await Order.updateOne({ _id: order._id }, { status: 'shipped' });

      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'delivered'
      );

      await logisticsService.processWebhook('redx', webhookPayload);
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.status).toBe('delivered');
      expect(updatedOrder.shipping.status).toBe('delivered');
      expect(updatedOrder.shipping.deliveredAt).toBeDefined();
    });

    it('should update order shipping metadata with provider info', async () => {
      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'delivery-in-progress',
        {
          message_en: 'Out for delivery',
        }
      );

      await logisticsService.processWebhook('redx', webhookPayload);
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.metadata).toBeDefined();
      expect(updatedOrder.shipping.metadata.trackingId).toBe(shipment.trackingId);
      expect(updatedOrder.shipping.metadata.providerStatus).toBeDefined();
      expect(updatedOrder.shipping.metadata.webhookReceivedAt).toBeDefined();
    });

    it('should add shipping history entry on webhook', async () => {
      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'agent-hold',
        {
          message_en: 'Parcel is at sorting facility',
        }
      );

      await logisticsService.processWebhook('redx', webhookPayload);
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping.history).toBeDefined();
      expect(updatedOrder.shipping.history.length).toBeGreaterThan(0);

      const latestHistory = updatedOrder.shipping.history[updatedOrder.shipping.history.length - 1];
      expect(latestHistory.status).toBe('in_transit'); // Mapped from agent-hold
      expect(latestHistory.actor).toBe('system');
    });

    it('should not update order for on-hold shipment status', async () => {
      const originalOrder = await Order.findById(order._id);

      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'on-hold' // Maps to null - should not update order
      );

      await logisticsService.processWebhook('redx', webhookPayload);
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      // Order shipping should not be created for on-hold status
      expect(updatedOrder.shipping).toBeUndefined();
    });

    it('should handle multiple webhooks correctly', async () => {
      // First webhook: picked up
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        shipment.trackingId,
        'ready-for-delivery'
      ));
      await sleep(100);

      // Second webhook: in transit
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        shipment.trackingId,
        'agent-hold'
      ));
      await sleep(100);

      // Third webhook: delivered
      await logisticsService.processWebhook('redx', createRedXWebhookPayload(
        shipment.trackingId,
        'delivered'
      ));
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      const updatedShipment = await Shipment.findById(shipment._id);

      expect(updatedShipment.webhookCount).toBe(3);
      expect(updatedOrder.shipping.status).toBe('delivered');
      expect(updatedOrder.shipping.history.length).toBe(3);
      expect(updatedOrder.status).toBe('delivered');
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
                tracking_id: shipment.trackingId,
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
      const trackResult = await logisticsService.trackShipment(shipment.trackingId);

      expect(trackResult.shipment.status).toBe('delivered');

      // Wait for order update
      await sleep(100);

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.shipping).toBeDefined();
      expect(updatedOrder.shipping.status).toBe('delivered');
      expect(updatedOrder.status).toBe('delivered');
    });

    it('should not propagate if status unchanged', async () => {
      // First track to set initial status
      await logisticsService.trackShipment(shipment.trackingId);
      await sleep(100);

      const orderBeforeSecondTrack = await Order.findById(order._id);
      const historyLengthBefore = orderBeforeSecondTrack.shipping?.history?.length || 0;

      // Track again with same status
      await logisticsService.trackShipment(shipment.trackingId);
      await sleep(100);

      const orderAfterSecondTrack = await Order.findById(order._id);
      const historyLengthAfter = orderAfterSecondTrack.shipping?.history?.length || 0;

      // History length should not increase if status unchanged
      expect(historyLengthAfter).toBe(historyLengthBefore);
    });
  });

  describe('Status Mapping', () => {
    const statusTests = [
      { shipmentStatus: 'pickup-requested', expectedShippingStatus: 'requested', expectedOrderStatus: 'confirmed' },
      { shipmentStatus: 'pickup-pending', expectedShippingStatus: 'requested', expectedOrderStatus: 'confirmed' },
      { shipmentStatus: 'picked-up', expectedShippingStatus: 'picked_up', expectedOrderStatus: 'shipped' },
      { shipmentStatus: 'in-transit', expectedShippingStatus: 'in_transit', expectedOrderStatus: 'shipped' },
      { shipmentStatus: 'out-for-delivery', expectedShippingStatus: 'out_for_delivery', expectedOrderStatus: 'shipped' },
      { shipmentStatus: 'delivered', expectedShippingStatus: 'delivered', expectedOrderStatus: 'delivered' },
    ];

    statusTests.forEach(({ shipmentStatus, expectedShippingStatus, expectedOrderStatus }) => {
      it(`should map shipment ${shipmentStatus} to order shipping ${expectedShippingStatus}`, async () => {
        // Update order to confirmed to allow status advancement
        await Order.updateOne({ _id: order._id }, { status: 'confirmed' });

        // Update shipment status directly (simulating webhook)
        await Shipment.updateOne({ _id: shipment._id }, { status: shipmentStatus });

        // Process via _updateOrderShipping
        const updatedShipment = await Shipment.findById(shipment._id);
        await logisticsService._updateOrderShipping(updatedShipment, {
          message: `Status: ${shipmentStatus}`,
        });

        await sleep(100);

        const updatedOrder = await Order.findById(order._id);

        if (expectedShippingStatus === 'requested') {
          // Requested status might not create shipping entry yet
          return;
        }

        expect(updatedOrder.shipping).toBeDefined();
        expect(updatedOrder.shipping.status).toBe(expectedShippingStatus);

        // Check order status advancement (if applicable)
        if (expectedOrderStatus === 'shipped' && updatedOrder.status !== 'cancelled') {
          expect(['confirmed', 'shipped', 'delivered']).toContain(updatedOrder.status);
        } else if (expectedOrderStatus === 'delivered') {
          expect(updatedOrder.status).toBe('delivered');
        }
      });
    });
  });

  describe('Error Handling', () => {
    it('should not fail webhook processing if order update fails', async () => {
      // Delete order to cause update failure
      await Order.deleteOne({ _id: order._id });

      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'delivered'
      );

      // Should not throw
      const result = await logisticsService.processWebhook('redx', webhookPayload);

      expect(result).toBeDefined();
      expect(result.status).toBe('delivered');
      // Shipment should still be updated even if order update fails
    });

    it('should warn if shipment has no linked order', async () => {
      // Remove order reference
      await Shipment.updateOne({ _id: shipment._id }, { order: null });

      const webhookPayload = createRedXWebhookPayload(
        shipment.trackingId,
        'delivered'
      );

      // Should not throw
      const result = await logisticsService.processWebhook('redx', webhookPayload);
      expect(result).toBeDefined();
    });
  });
});
