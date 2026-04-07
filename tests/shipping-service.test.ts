import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';

/**
 * Shipping Service Tests
 *
 * Tests for shipping.service.ts status transitions, order status mapping,
 * history tracking, and validation. Uses mongodb-memory-server for DB-backed
 * operations through the Order model.
 */

let shouldDisconnect = false;

// Modules loaded after connection
let Order: typeof import('#resources/sales/orders/order.model.js').default;
let shippingService: typeof import('#resources/sales/orders/shipping.service.js').default;
let enums: typeof import('#resources/sales/orders/order.enums.js');

// Helper: create a minimal order in the DB
async function createTestOrder(overrides: Record<string, unknown> = {}) {
  return Order.create({
    customerName: 'Shipping Test Customer',
    customerPhone: '01700000000',
    items: [{
      product: new Types.ObjectId(),
      productName: 'Test Product',
      quantity: 1,
      price: 1000,
    }],
    totalAmount: 1000,
    status: 'confirmed',
    source: 'web',
    delivery: { method: 'standard', price: 60 },
    deliveryAddress: {
      recipientName: 'Test',
      recipientPhone: '01700000000',
      addressLine1: 'House 1, Road 1',
      city: 'Dhaka',
      country: 'Bangladesh',
    },
    currentPayment: {
      method: 'bkash',
      amount: 106000,
      status: 'verified',
    },
    ...overrides,
  });
}

describe('Shipping Service', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
      shouldDisconnect = true;
    }

    Order = (await import('#resources/sales/orders/order.model.js')).default;
    shippingService = (await import('#resources/sales/orders/shipping.service.js')).default;
    enums = await import('#resources/sales/orders/order.enums.js');
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Order.deleteMany({});
  });

  // ─── Shipping Status Transitions (enum-level) ─────────

  describe('SHIPPING_STATUS_TRANSITIONS', () => {
    it('allows pending -> requested', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.PENDING];
      expect(allowed).toContain(enums.SHIPPING_STATUS.REQUESTED);
    });

    it('allows requested -> picked_up', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.REQUESTED];
      expect(allowed).toContain(enums.SHIPPING_STATUS.PICKED_UP);
    });

    it('allows picked_up -> in_transit', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.PICKED_UP];
      expect(allowed).toContain(enums.SHIPPING_STATUS.IN_TRANSIT);
    });

    it('allows in_transit -> out_for_delivery', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.IN_TRANSIT];
      expect(allowed).toContain(enums.SHIPPING_STATUS.OUT_FOR_DELIVERY);
    });

    it('allows out_for_delivery -> delivered', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.OUT_FOR_DELIVERY];
      expect(allowed).toContain(enums.SHIPPING_STATUS.DELIVERED);
    });

    it('allows out_for_delivery -> failed_attempt', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.OUT_FOR_DELIVERY];
      expect(allowed).toContain(enums.SHIPPING_STATUS.FAILED_ATTEMPT);
    });

    it('allows failed_attempt -> out_for_delivery (retry)', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.FAILED_ATTEMPT];
      expect(allowed).toContain(enums.SHIPPING_STATUS.OUT_FOR_DELIVERY);
    });

    it('allows failed_attempt -> returned', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.FAILED_ATTEMPT];
      expect(allowed).toContain(enums.SHIPPING_STATUS.RETURNED);
    });

    it('does not allow delivered -> any transition (terminal state)', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.DELIVERED];
      expect(allowed).toHaveLength(0);
    });

    it('does not allow returned -> any transition (terminal state)', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.RETURNED];
      expect(allowed).toHaveLength(0);
    });

    it('does not allow cancelled -> any transition (terminal state)', () => {
      const allowed = enums.SHIPPING_STATUS_TRANSITIONS[enums.SHIPPING_STATUS.CANCELLED];
      expect(allowed).toHaveLength(0);
    });
  });

  // ─── SHIPPING_TO_ORDER_STATUS_MAP ─────────────────────

  describe('SHIPPING_TO_ORDER_STATUS_MAP', () => {
    it('maps picked_up to shipped', () => {
      expect(enums.SHIPPING_TO_ORDER_STATUS_MAP[enums.SHIPPING_STATUS.PICKED_UP])
        .toBe(enums.ORDER_STATUS.SHIPPED);
    });

    it('maps in_transit to shipped', () => {
      expect(enums.SHIPPING_TO_ORDER_STATUS_MAP[enums.SHIPPING_STATUS.IN_TRANSIT])
        .toBe(enums.ORDER_STATUS.SHIPPED);
    });

    it('maps out_for_delivery to shipped', () => {
      expect(enums.SHIPPING_TO_ORDER_STATUS_MAP[enums.SHIPPING_STATUS.OUT_FOR_DELIVERY])
        .toBe(enums.ORDER_STATUS.SHIPPED);
    });

    it('maps delivered to delivered', () => {
      expect(enums.SHIPPING_TO_ORDER_STATUS_MAP[enums.SHIPPING_STATUS.DELIVERED])
        .toBe(enums.ORDER_STATUS.DELIVERED);
    });
  });

  // ─── _isValidTransition (internal method) ─────────────

  describe('_isValidTransition', () => {
    it('accepts valid forward transition', () => {
      expect(shippingService._isValidTransition('requested', 'picked_up')).toBe(true);
    });

    it('rejects backward transition', () => {
      expect(shippingService._isValidTransition('in_transit', 'requested')).toBe(false);
    });

    it('rejects same-status transition', () => {
      expect(shippingService._isValidTransition('in_transit', 'in_transit')).toBe(false);
    });

    it('rejects transitions from terminal states', () => {
      expect(shippingService._isValidTransition('delivered', 'returned')).toBe(false);
      expect(shippingService._isValidTransition('returned', 'in_transit')).toBe(false);
      expect(shippingService._isValidTransition('cancelled', 'requested')).toBe(false);
    });
  });

  // ─── _shouldAdvanceOrderStatus ────────────────────────

  describe('_shouldAdvanceOrderStatus', () => {
    it('advances from confirmed to shipped', () => {
      expect(shippingService._shouldAdvanceOrderStatus('confirmed', 'shipped')).toBe(true);
    });

    it('advances from shipped to delivered', () => {
      expect(shippingService._shouldAdvanceOrderStatus('shipped', 'delivered')).toBe(true);
    });

    it('does not go backward from shipped to confirmed', () => {
      expect(shippingService._shouldAdvanceOrderStatus('shipped', 'confirmed')).toBe(false);
    });

    it('does not advance to same status', () => {
      expect(shippingService._shouldAdvanceOrderStatus('shipped', 'shipped')).toBe(false);
    });
  });

  // ─── requestPickup (DB integration) ───────────────────

  describe('requestPickup', () => {
    it('creates shipping data on order with history entry', async () => {
      const order = await createTestOrder();

      const result = await shippingService.requestPickup(order._id.toString(), {
        provider: 'redx',
        trackingNumber: 'TRK-12345',
        consignmentId: 'CON-12345',
      });

      expect(result.shipping.provider).toBe('redx');
      expect(result.shipping.status).toBe('requested');
      expect(result.shipping.trackingNumber).toBe('TRK-12345');
      expect(result.shipping.consignmentId).toBe('CON-12345');
      expect(result.shipping.requestedAt).toBeDefined();
      expect(result.shipping.history).toHaveLength(1);
      expect(result.shipping.history[0].status).toBe('requested');
    });

    it('throws for non-existent order', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        shippingService.requestPickup(fakeId, { provider: 'redx' }),
      ).rejects.toThrow('Order not found');
    });

    it('throws for cancelled order', async () => {
      const order = await createTestOrder({ status: 'cancelled' });

      await expect(
        shippingService.requestPickup(order._id.toString(), { provider: 'redx' }),
      ).rejects.toThrow('Cannot request shipping for cancelled order');
    });

    it('throws when payment is not verified', async () => {
      const order = await createTestOrder({
        currentPayment: { method: 'bkash', amount: 100000, status: 'pending' },
      });

      await expect(
        shippingService.requestPickup(order._id.toString(), { provider: 'redx' }),
      ).rejects.toThrow('Payment must be verified');
    });
  });

  // ─── updateStatus (DB integration) ────────────────────

  describe('updateStatus', () => {
    // Helper: create order with shipping already requested
    async function createOrderWithShipping() {
      const order = await createTestOrder();
      await shippingService.requestPickup(order._id.toString(), {
        provider: 'redx',
        trackingNumber: 'TRK-UPDATE-TEST',
      });
      return order;
    }

    it('transitions from requested to picked_up and sets pickedUpAt', async () => {
      const order = await createOrderWithShipping();

      const result = await shippingService.updateStatus(
        order._id.toString(),
        { status: 'picked_up', note: 'Picked up by rider' },
      );

      expect(result.shipping.status).toBe('picked_up');
      expect(result.shipping.pickedUpAt).toBeDefined();
      expect(result.shipping.history).toHaveLength(2); // requested + picked_up
    });

    it('advances order status to shipped on picked_up', async () => {
      const order = await createOrderWithShipping();

      const result = await shippingService.updateStatus(
        order._id.toString(),
        { status: 'picked_up' },
      );

      // Order was confirmed, picked_up maps to shipped
      expect(result.order.status).toBe('shipped');
    });

    it('transitions through full happy path: requested -> picked_up -> in_transit -> out_for_delivery -> delivered', async () => {
      const order = await createOrderWithShipping();
      const orderId = order._id.toString();

      await shippingService.updateStatus(orderId, { status: 'picked_up' });
      await shippingService.updateStatus(orderId, { status: 'in_transit' });
      await shippingService.updateStatus(orderId, { status: 'out_for_delivery' });
      const result = await shippingService.updateStatus(orderId, { status: 'delivered' });

      expect(result.shipping.status).toBe('delivered');
      expect(result.shipping.deliveredAt).toBeDefined();
      expect(result.order.status).toBe('delivered');
      // 1 (requested) + 4 status updates = 5 history entries
      expect(result.shipping.history).toHaveLength(5);
    });

    it('rejects invalid transition (requested -> delivered)', async () => {
      const order = await createOrderWithShipping();

      await expect(
        shippingService.updateStatus(
          order._id.toString(),
          { status: 'delivered' },
        ),
      ).rejects.toThrow('Invalid status transition');
    });

    it('rejects invalid transition (picked_up -> delivered)', async () => {
      const order = await createOrderWithShipping();

      await shippingService.updateStatus(order._id.toString(), { status: 'picked_up' });

      await expect(
        shippingService.updateStatus(
          order._id.toString(),
          { status: 'delivered' },
        ),
      ).rejects.toThrow('Invalid status transition');
    });

    it('throws when order has no shipping data and allowBootstrap is false', async () => {
      const order = await createTestOrder();

      await expect(
        shippingService.updateStatus(
          order._id.toString(),
          { status: 'picked_up' },
        ),
      ).rejects.toThrow('No shipping data found');
    });

    it('allows bootstrap when allowBootstrap is true', async () => {
      const order = await createTestOrder();

      const result = await shippingService.updateStatus(
        order._id.toString(),
        { status: 'in_transit', metadata: { provider: 'redx', trackingNumber: 'TRK-BOOT' } },
        { allowBootstrap: true },
      );

      expect(result.shipping.status).toBe('in_transit');
      expect(result.shipping.provider).toBe('redx');
    });

    it('tracks status history with notes and actors', async () => {
      const order = await createOrderWithShipping();

      await shippingService.updateStatus(
        order._id.toString(),
        { status: 'picked_up', note: 'Picked up at warehouse' },
        { actorId: 'rider-001' },
      );

      const info = await shippingService.getShippingInfo(order._id.toString());
      const lastEntry = info!.history[info!.history.length - 1];

      expect(lastEntry.status).toBe('picked_up');
      expect(lastEntry.note).toBe('Picked up at warehouse');
      expect(lastEntry.actor).toBe('rider-001');
      expect(lastEntry.timestamp).toBeDefined();
    });

    it('merges metadata on status update', async () => {
      const order = await createOrderWithShipping();

      await shippingService.updateStatus(
        order._id.toString(),
        { status: 'picked_up', metadata: { riderName: 'Karim' } },
      );

      await shippingService.updateStatus(
        order._id.toString(),
        { status: 'in_transit', metadata: { hubName: 'Dhaka Hub' } },
      );

      const info = await shippingService.getShippingInfo(order._id.toString());
      const meta = info!.metadata as Record<string, unknown>;

      expect(meta.riderName).toBe('Karim');
      expect(meta.hubName).toBe('Dhaka Hub');
    });

    it('handles failed_attempt -> out_for_delivery retry', async () => {
      const order = await createOrderWithShipping();
      const orderId = order._id.toString();

      await shippingService.updateStatus(orderId, { status: 'picked_up' });
      await shippingService.updateStatus(orderId, { status: 'in_transit' });
      await shippingService.updateStatus(orderId, { status: 'out_for_delivery' });
      await shippingService.updateStatus(orderId, { status: 'failed_attempt', note: 'Customer not home' });

      // Retry delivery
      const result = await shippingService.updateStatus(orderId, {
        status: 'out_for_delivery',
        note: 'Reattempting delivery',
      });

      expect(result.shipping.status).toBe('out_for_delivery');
      // Should have 7 history entries total
      expect(result.shipping.history.length).toBeGreaterThanOrEqual(6);
    });
  });

  // ─── getShippingInfo ──────────────────────────────────

  describe('getShippingInfo', () => {
    it('returns null when order has no shipping', async () => {
      const order = await createTestOrder();
      const info = await shippingService.getShippingInfo(order._id.toString());
      expect(info).toBeNull();
    });

    it('returns shipping data when present', async () => {
      const order = await createTestOrder();
      await shippingService.requestPickup(order._id.toString(), {
        provider: 'redx',
        trackingNumber: 'TRK-INFO',
      });

      const info = await shippingService.getShippingInfo(order._id.toString());

      expect(info).toBeDefined();
      expect(info!.provider).toBe('redx');
      expect(info!.trackingNumber).toBe('TRK-INFO');
    });

    it('throws for non-existent order', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        shippingService.getShippingInfo(fakeId),
      ).rejects.toThrow('Order not found');
    });
  });
});
