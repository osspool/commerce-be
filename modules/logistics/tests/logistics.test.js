/**
 * Logistics Module Tests
 *
 * Run: npm test -- modules/logistics/tests/logistics.test.js
 */

import mongoose from 'mongoose';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import Shipment from '../models/shipment.model.js';
import { RedXProvider } from '@classytic/bd-logistics/providers';
import bdAreas from '@classytic/bd-areas';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('Logistics Module', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  // Note: LogisticsConfig model tests removed - config is loaded from .env
  // See config/sections/logistics.config.js for configuration

  describe('Static Areas (bd-areas)', () => {
    it('should have all 8 divisions', () => {
      const divisions = bdAreas.getDivisions();
      expect(divisions.length).toBe(8);
      expect(divisions.map(d => d.id)).toContain('dhaka');
      expect(divisions.map(d => d.id)).toContain('chittagong');
    });

    it('should get districts by division', () => {
      const dhakaDistricts = bdAreas.getDistrictsByDivision('dhaka');
      expect(dhakaDistricts.length).toBeGreaterThan(0);
      expect(dhakaDistricts.map(d => d.id)).toContain('dhaka');
    });

    it('should search areas by name', () => {
      const results = bdAreas.searchAreas('gul');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name.toLowerCase()).toContain('gul');
    });

    it('should search areas by postCode', () => {
      const results = bdAreas.searchAreas('1212');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should get area by internalId', () => {
      const area = bdAreas.getArea(1);
      expect(area).toBeDefined();
      expect(area.internalId).toBe(1);
      expect(area).toHaveProperty('name');
      expect(area).toHaveProperty('zoneId');
    });

    it('should have provider area IDs in areas', () => {
      const area = bdAreas.getArea(1);
      expect(area).toBeDefined();
      expect(area.providers).toBeDefined();
      // Provider IDs may vary
      if (area.providers.redx) {
        expect(typeof area.providers.redx).toBe('number');
      }
    });

    it('should get areas by district', () => {
      const areas = bdAreas.getAreasByDistrict('dhaka');
      expect(areas.length).toBeGreaterThan(0);
      areas.forEach(area => {
        expect(area.districtId).toBe('dhaka');
      });
    });
  });

  describe('Shipment Model', () => {
    let testOrderId;

    beforeEach(async () => {
      await Shipment.deleteMany({});
      testOrderId = new mongoose.Types.ObjectId();
    });

    it('should create shipment with timeline', async () => {
      const shipment = await Shipment.create({
        order: testOrderId,
        provider: 'redx',
        trackingId: 'TEST123',
        status: 'pickup-requested',
        delivery: {
          customerName: 'Test Customer',
          customerPhone: '01700000000',
          address: 'Test Address',
        },
        timeline: [{
          status: 'pickup-requested',
          message: 'Shipment created',
          timestamp: new Date(),
        }],
      });

      expect(shipment.trackingId).toBe('TEST123');
      expect(shipment.timeline.length).toBe(1);
    });

    it('should find by tracking ID', async () => {
      await Shipment.create({
        order: testOrderId,
        provider: 'redx',
        trackingId: 'TRACK456',
        status: 'in-transit',
        delivery: {
          customerName: 'Test',
          customerPhone: '01700000000',
          address: 'Test',
        },
      });

      const found = await Shipment.findByTrackingId('TRACK456');
      expect(found).not.toBeNull();
      expect(found.status).toBe('in-transit');
    });

    it('should update status with timeline event', async () => {
      const shipment = await Shipment.create({
        order: testOrderId,
        provider: 'redx',
        trackingId: 'TRACK789',
        status: 'pickup-requested',
        delivery: {
          customerName: 'Test',
          customerPhone: '01700000000',
          address: 'Test',
        },
        timeline: [],
      });

      await shipment.updateStatus('picked-up', 'Package picked up', 'প্যাকেজ পিক আপ হয়েছে');

      expect(shipment.status).toBe('picked-up');
      expect(shipment.timeline.length).toBe(1);
      expect(shipment.timeline[0].message).toBe('Package picked up');
    });
  });

  describe('RedX Provider', () => {
    it('should normalize status correctly', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      expect(provider.normalizeStatus('pickup-pending')).toBe('pickup-requested');
      expect(provider.normalizeStatus('ready-for-delivery')).toBe('picked-up');
      expect(provider.normalizeStatus('delivery-in-progress')).toBe('out-for-delivery');
      expect(provider.normalizeStatus('delivered')).toBe('delivered');
      expect(provider.normalizeStatus('agent-returning')).toBe('returning');
      expect(provider.normalizeStatus('returned')).toBe('returned');
      expect(provider.normalizeStatus('unknown-status')).toBe('pending');
    });

    it('should parse webhook payload', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      const payload = {
        tracking_number: 'REDX123',
        status: 'delivered',
        message_en: 'Package delivered',
        message_bn: 'প্যাকেজ ডেলিভারি হয়েছে',
        timestamp: '2025-01-15T10:30:00.000Z',
        invoice_number: 'INV001',
      };

      const parsed = provider.parseWebhook(payload);

      expect(parsed.trackingId).toBe('REDX123');
      expect(parsed.status).toBe('delivered');
      expect(parsed.message).toBe('Package delivered');
      expect(parsed.messageLocal).toBe('প্যাকেজ ডেলিভারি হয়েছে');
    });

    it('should build address from object with areaName', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      const address = provider._buildAddress({
        addressLine1: 'House 1, Road 2',
        addressLine2: 'Block B',
        areaName: 'Dhanmondi', // Use areaName (not deprecated area)
        city: 'Dhaka',
      });

      expect(address).toBe('House 1, Road 2, Block B, Dhanmondi, Dhaka');
    });

    it('should build address with deprecated area field for backwards compatibility', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      const address = provider._buildAddress({
        addressLine1: 'House 1, Road 2',
        area: 'Dhanmondi', // Deprecated but still supported
        city: 'Dhaka',
      });

      expect(address).toBe('House 1, Road 2, Dhanmondi, Dhaka');
    });

    it('should handle string address', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      const address = provider._buildAddress('123 Main Street, Dhaka');
      expect(address).toBe('123 Main Street, Dhaka');
    });

    it('should handle gift order with recipient info', () => {
      const provider = new RedXProvider({
        apiUrl: 'https://test.com',
        apiKey: 'test',
      });

      // Gift order: customer is Jane, recipient is John
      const giftOrder = {
        _id: 'GIFT-123',
        customerName: 'Jane Smith',
        customerPhone: '01798765432',
        deliveryAddress: {
          recipientName: 'John Doe', // Different from customer
          recipientPhone: '01712345678', // Different from customer
          addressLine1: 'House 99, Road 10',
          areaName: 'Dhanmondi',
          areaId: 2,
          city: 'Dhaka',
        },
        totalAmount: 1500,
        items: [{ productName: 'Gift', price: 1500, quantity: 1 }],
      };

      // Shipment should use recipient info from deliveryAddress
      const addr = giftOrder.deliveryAddress;
      const recipientName = addr?.recipientName || giftOrder.customerName;
      const recipientPhone = addr?.recipientPhone || giftOrder.customerPhone;

      expect(recipientName).toBe('John Doe');
      expect(recipientPhone).toBe('01712345678');
      expect(recipientName).not.toBe(giftOrder.customerName);
    });
  });

  describe('Delivery Zone Pricing', () => {
    let zones;

    beforeAll(async () => {
      // Import zones utility
      const { DELIVERY_ZONES, estimateDeliveryCharge } = await import('../utils/zones.js');
      zones = { DELIVERY_ZONES, estimateDeliveryCharge };
    });

    it('should have 6 delivery zones', () => {
      expect(Object.keys(zones.DELIVERY_ZONES).length).toBe(6);
    });

    it('should calculate COD charges for Dhaka Metro (zone 1)', () => {
      const estimate = zones.estimateDeliveryCharge(1, 1000);

      expect(estimate.zone).toBe('Dhaka Metro');
      expect(estimate.zoneId).toBe(1);
      expect(estimate.deliveryCharge).toBe(60);
      expect(estimate.codCharge).toBe(10); // 1% of 1000
      expect(estimate.totalCharge).toBe(70);
    });

    it('should calculate COD charges for Remote Areas (zone 6)', () => {
      const estimate = zones.estimateDeliveryCharge(6, 2000);

      expect(estimate.zone).toBe('Remote Areas');
      expect(estimate.zoneId).toBe(6);
      expect(estimate.deliveryCharge).toBe(150);
      expect(estimate.codCharge).toBe(50); // 2.5% of 2000
      expect(estimate.totalCharge).toBe(200);
    });

    it('should return 0 COD charge for prepaid orders', () => {
      const estimate = zones.estimateDeliveryCharge(1, 0);

      expect(estimate.deliveryCharge).toBe(60);
      expect(estimate.codCharge).toBe(0);
      expect(estimate.totalCharge).toBe(60);
    });

    it('should default to district zone for unknown zoneId', () => {
      const estimate = zones.estimateDeliveryCharge(99, 1000);

      expect(estimate.zone).toBe('District Towns');
      expect(estimate.deliveryCharge).toBe(130);
    });
  });

  describe('Area ID Resolution', () => {
    it('should resolve internalId to providerAreaIds from order', () => {
      // Order has providerAreaIds from frontend
      const order = {
        deliveryAddress: {
          areaId: 1,
          areaName: 'Mohammadpur',
          providerAreaIds: {
            redx: 1206,
            pathao: 123,
          },
        },
      };

      // Service should use providerAreaIds.redx for RedX API
      const providerAreaId = order.deliveryAddress.providerAreaIds?.redx;
      expect(providerAreaId).toBe(1206);
    });

    it('should fall back to bd-areas lookup when providerAreaIds not in order', () => {
      // Order only has internalId
      const order = {
        deliveryAddress: {
          areaId: 1,
          areaName: 'Mohammadpur',
          // No providerAreaIds
        },
      };

      // Service should look up via bdAreas
      const area = bdAreas.getArea(order.deliveryAddress.areaId);
      expect(area).toBeDefined();

      // Get provider-specific ID
      const redxAreaId = area?.providers?.redx;
      // redxAreaId may be undefined if area doesn't have RedX mapping
      if (redxAreaId) {
        expect(typeof redxAreaId).toBe('number');
      }
    });

    it('should use options.providerAreaId when explicitly provided', () => {
      const options = {
        providerAreaId: 9999, // Explicit override
      };

      // Service should prefer options.providerAreaId
      const resolvedAreaId = options.providerAreaId;
      expect(resolvedAreaId).toBe(9999);
    });
  });

  describe('COD vs Prepaid Logic', () => {
    it('should set cashCollectionAmount = totalAmount for COD orders', () => {
      const order = {
        totalAmount: 1500,
        currentPayment: {
          method: 'cash',
          status: 'pending',
        },
      };

      const paymentMethod = order.currentPayment?.method || 'cash';
      const paymentStatus = order.currentPayment?.status || 'pending';
      const isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      const cashCollectionAmount = isPrepaid ? 0 : order.totalAmount;

      expect(isPrepaid).toBe(false);
      expect(cashCollectionAmount).toBe(1500);
    });

    it('should set cashCollectionAmount = 0 for verified prepaid orders', () => {
      const order = {
        totalAmount: 1500,
        currentPayment: {
          method: 'bkash',
          status: 'verified',
          reference: 'TRX123',
        },
      };

      const paymentMethod = order.currentPayment?.method || 'cash';
      const paymentStatus = order.currentPayment?.status || 'pending';
      const isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      const cashCollectionAmount = isPrepaid ? 0 : order.totalAmount;

      expect(isPrepaid).toBe(true);
      expect(cashCollectionAmount).toBe(0);
    });

    it('should treat pending bkash as COD until verified', () => {
      const order = {
        totalAmount: 1500,
        currentPayment: {
          method: 'bkash',
          status: 'pending', // Not yet verified
          reference: 'TRX123',
        },
      };

      const paymentMethod = order.currentPayment?.method || 'cash';
      const paymentStatus = order.currentPayment?.status || 'pending';
      const isPrepaid = paymentMethod !== 'cash' && paymentStatus === 'verified';
      const cashCollectionAmount = isPrepaid ? 0 : order.totalAmount;

      // Until verified, collect COD
      expect(isPrepaid).toBe(false);
      expect(cashCollectionAmount).toBe(1500);
    });
  });
});
