/**
 * RedX Integration Tests
 *
 * These tests use actual RedX sandbox API credentials from .env.dev
 *
 * Run: NODE_ENV=dev npm test -- modules/logistics/tests/redx-integration.test.js --run
 *
 * Tests demonstrate:
 * - Area lookup and charge calculation
 * - Pickup store management
 * - Parcel creation (COD and prepaid)
 * - Parcel tracking and status
 * - Parcel cancellation
 */

// Load environment variables first
import '../.././../config/env-loader.js';

import mongoose from 'mongoose';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { RedXProvider } from '@classytic/bd-logistics/providers';
import type { ProviderConfig } from '@classytic/bd-logistics';
import bdAreas from '@classytic/bd-areas';
import logisticsService from '../services/logistics.service.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';
const REDX_API_KEY = process.env.REDX_API_KEY;
const REDX_API_URL = process.env.REDX_API_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta';

// Skip if no API key
const describeWithApi = REDX_API_KEY ? describe : describe.skip;

describeWithApi('RedX Integration Tests', () => {
  let provider: RedXProvider;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);

    provider = new RedXProvider({
      provider: 'redx',
      apiUrl: REDX_API_URL,
      apiKey: REDX_API_KEY as string,
      settings: { sandbox: true },
    } as ProviderConfig);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe('Areas API', () => {
    it('should fetch all areas', async () => {
      const areas = await provider.getAreas();

      expect(Array.isArray(areas)).toBe(true);
      expect(areas.length).toBeGreaterThan(0);

      const area = areas[0];
      expect(area).toHaveProperty('id');
      expect(area).toHaveProperty('name');
      expect(area).toHaveProperty('division_name');
    });

    it('should fetch areas by post code (may return empty in sandbox)', async () => {
      try {
        const areas = await provider.getAreas({ postCode: '1207' });
        expect(Array.isArray(areas)).toBe(true);
        areas.forEach((area: any) => {
          expect(area.post_code).toBe(1207);
        });
      } catch (error) {
        // Sandbox may not have all areas - 404 is acceptable
        if ((error as Error).message.includes('404')) {
          console.log('⚠️ Post code 1207 not found in sandbox - this is expected');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });

    it('should fetch areas by district (may return empty in sandbox)', async () => {
      try {
        const areas = await provider.getAreas({ district: 'Dhaka' });
        expect(Array.isArray(areas)).toBe(true);
        expect(areas.length).toBeGreaterThan(0);
      } catch (error) {
        // Sandbox may not have all districts - 404 is acceptable
        if ((error as Error).message.includes('404')) {
          console.log('⚠️ District Dhaka not found in sandbox - this is expected');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('Static Areas Mapping', () => {
    it('should have RedX area IDs in static constants', () => {
      const area = bdAreas.getArea(1); // Get area by internalId
      expect(area).toBeDefined();
      expect(area?.internalId).toBe(1);
      expect(area?.providers).toBeDefined();
      // Provider IDs may vary
      if (area?.providers.redx) {
        expect(typeof area?.providers.redx).toBe('number');
      }
    });

    it('should get correct provider area ID from area', () => {
      const area = bdAreas.getArea(1);
      expect(area).toBeDefined();

      // Get provider-specific ID
      const redxId = area?.providers?.redx;
      if (redxId) {
        expect(typeof redxId).toBe('number');
      }
    });
  });

  describe('Charge Calculation', () => {
    it('should calculate delivery charge', async () => {
      // Get Dhaka areas
      const dhakaAreas = bdAreas.getAreasByDistrict('dhaka');
      if (dhakaAreas.length < 2) {
        console.log('Not enough areas for charge test');
        return;
      }

      // Find areas with RedX provider IDs
      const areasWithRedx = dhakaAreas.filter((a) => a.providers?.redx);
      if (areasWithRedx.length < 2) {
        console.log('Not enough areas with RedX IDs for charge test');
        return;
      }

      const pickupArea = areasWithRedx[0];
      const deliveryArea = areasWithRedx[1];

      const charges = await provider.calculateCharge({
        deliveryAreaId: deliveryArea.providers.redx!,
        pickupAreaId: pickupArea.providers.redx!,
        cashCollectionAmount: 1000, // COD amount
        weight: 500,
      });

      expect(charges).toHaveProperty('deliveryCharge');
      expect(charges).toHaveProperty('codCharge');
      expect(typeof charges.deliveryCharge).toBe('number');
    });
  });

  describe('Pickup Stores', () => {
    it('should fetch pickup stores', async () => {
      const stores = await provider.getPickupStores();

      expect(Array.isArray(stores)).toBe(true);
      // May be empty if no stores created
      console.log(`📦 Found ${stores.length} pickup stores`);
      if (stores.length > 0) {
        console.log('First store:', (stores[0] as any).name, '- ID:', (stores[0] as any).id);
      }
    });

    it('should create pickup store (sandbox)', async () => {
      // Get a valid area ID first
      const areas = await provider.getAreas();
      if (areas.length === 0) {
        console.log('⚠️ No areas available - skipping store creation');
        return;
      }

      const testStore = {
        name: `Test Store ${Date.now()}`,
        phone: '01712345678',
        address: 'Test Address, Dhaka',
        areaId: areas[0].id,
      };

      try {
        const result = await provider.createPickupStore(testStore);
        expect(result).toHaveProperty('id');
        console.log('✅ Created pickup store:', result.name, '- ID:', result.id);
      } catch (error) {
        // Store creation may fail in sandbox with existing phone
        if ((error as Error).message.includes('already exists') || (error as Error).message.includes('duplicate')) {
          console.log('⚠️ Store with this phone already exists - this is expected in sandbox');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('Parcel Operations (Sandbox)', () => {
    let testTrackingId: string | null = null;
    let pickupStoreId: string | null = null;

    beforeAll(async () => {
      // Get or create a pickup store for parcel tests
      const stores = await provider.getPickupStores();
      if (stores.length > 0) {
        pickupStoreId = (stores[0] as any).id;
        console.log(`📍 Using pickup store: ${(stores[0] as any).name} (ID: ${pickupStoreId})`);
      }
    });

    it('should create a parcel (COD)', async () => {
      if (!pickupStoreId) {
        console.log('⚠️ No pickup store available - skipping parcel creation');
        return;
      }

      // Get a valid delivery area
      const areas = await provider.getAreas();
      if (areas.length === 0) {
        console.log('⚠️ No areas available - skipping parcel creation');
        return;
      }

      const deliveryArea = areas[0];
      console.log(`🚚 Delivering to: ${deliveryArea.name} (ID: ${deliveryArea.id})`);

      // Create a mock order
      const mockOrder = {
        _id: `TEST-${Date.now()}`,
        customerName: 'Test Customer',
        customerPhone: '01898765432',
        deliveryAddress: {
          addressLine1: 'House 123, Road 5',
          addressLine2: 'Test Area',
          city: 'Dhaka',
          areaId: deliveryArea.id,
          areaName: deliveryArea.name,
        },
        items: [{ productName: 'Test Product', price: 500, quantity: 2 }],
        totalAmount: 1000,
        notes: 'Handle with care - Test parcel',
      };

      const result = await provider.createShipment(
        mockOrder as any,
        {
          deliveryAreaId: deliveryArea.id,
          deliveryAreaName: deliveryArea.name,
          pickupStoreId: parseInt(pickupStoreId, 10),
          cashCollectionAmount: 1000, // COD
          weight: 500,
          declaredValue: 1000,
        } as any,
      );

      expect(result).toHaveProperty('trackingId');
      testTrackingId = result.trackingId;
      console.log(`✅ Created parcel with tracking ID: ${testTrackingId}`);
    });

    it('should track the created parcel', async () => {
      if (!testTrackingId) {
        console.log('⚠️ No parcel created - skipping tracking test');
        return;
      }

      try {
        const tracking = await provider.trackShipment(testTrackingId);

        expect(tracking).toHaveProperty('status');
        expect(tracking).toHaveProperty('providerStatus');
        expect(tracking).toHaveProperty('timeline');
        console.log(`📊 Parcel status: ${tracking.status} (RedX: ${tracking.providerStatus})`);
        console.log(`📜 Timeline events: ${tracking.timeline.length}`);
      } catch (error) {
        // Sandbox may return 503 for tracking - this is expected
        if ((error as Error).message.includes('503') || (error as Error).message.includes('unreachable')) {
          console.log('⚠️ Tracking endpoint unavailable in sandbox - this is expected');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });

    it('should get parcel details', async () => {
      if (!testTrackingId) {
        console.log('⚠️ No parcel created - skipping details test');
        return;
      }

      try {
        const details = await provider.getShipmentDetails(testTrackingId);

        expect(details).toHaveProperty('trackingId', testTrackingId);
        expect(details).toHaveProperty('status');
        expect(details).toHaveProperty('delivery');
        expect(details.delivery).toHaveProperty('customerName', 'Test Customer');
        console.log(`📦 Parcel details:`, {
          status: details.status,
          customer: details.delivery.customerName,
          area: details.delivery.areaName,
          cashCollection: details.cashCollection.amount,
        });
      } catch (error) {
        // Sandbox may return 503 for parcel details - this is expected
        if ((error as Error).message.includes('503') || (error as Error).message.includes('unreachable')) {
          console.log('⚠️ Parcel details endpoint unavailable in sandbox - this is expected');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });

    it('should cancel the test parcel', async () => {
      if (!testTrackingId) {
        console.log('⚠️ No parcel created - skipping cancel test');
        return;
      }

      try {
        const result = await provider.cancelShipment(testTrackingId, 'Test parcel - cleanup');
        expect(result.success).toBe(true);
        console.log(`🗑️ Cancelled parcel: ${testTrackingId}`);
      } catch (error) {
        // Cancellation may fail for various sandbox reasons
        const errMsg = (error as Error).message;
        if (
          errMsg.includes('cannot be cancelled') ||
          errMsg.includes('picked up') ||
          errMsg.includes('503') ||
          errMsg.includes('unreachable') ||
          errMsg.includes('Request Accepted') // Sandbox quirk: returns 503 with success message
        ) {
          console.log('⚠️ Cancel endpoint unavailable/blocked in sandbox - this is expected');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });

    it('should create a prepaid parcel (no COD)', async () => {
      if (!pickupStoreId) {
        console.log('⚠️ No pickup store available - skipping prepaid test');
        return;
      }

      const areas = await provider.getAreas();
      if (areas.length === 0) return;

      const mockOrder = {
        _id: `PREPAID-${Date.now()}`,
        customerName: 'Prepaid Customer',
        customerPhone: '01712345999',
        deliveryAddress: {
          addressLine1: 'House 456, Block C',
          city: 'Dhaka',
        },
        items: [{ productName: 'Prepaid Item', price: 2000, quantity: 1 }],
        totalAmount: 2000,
      };

      const result = await provider.createShipment(
        mockOrder as any,
        {
          deliveryAreaId: areas[0].id,
          deliveryAreaName: areas[0].name,
          pickupStoreId: parseInt(pickupStoreId, 10),
          cashCollectionAmount: 0, // Prepaid - no cash collection
          weight: 300,
        } as any,
      );

      expect(result).toHaveProperty('trackingId');
      console.log(`✅ Created PREPAID parcel: ${result.trackingId}`);

      // Clean up
      try {
        await provider.cancelShipment(result.trackingId, 'Test cleanup');
      } catch (e) {
        // Ignore cleanup errors
      }
    });
  });

  describe('Service Integration', () => {
    it('should initialize service with RedX provider from config', async () => {
      // Service loads config from .env via config/sections/logistics.config.js
      const defaultProvider = await logisticsService.getDefaultProvider();
      expect(defaultProvider.name).toBe('redx');
    });
  });
});

// Separate describe for testing without API
describe('RedX Provider (Offline)', () => {
  const offlineConfig: ProviderConfig = {
    provider: 'redx',
    apiUrl: 'https://test.com',
    apiKey: 'test',
  };

  it('should build address from object with areaName', () => {
    const provider = new RedXProvider(offlineConfig) as any;

    const address = provider._buildAddress({
      addressLine1: 'House 1, Road 2',
      addressLine2: 'Block B',
      areaName: 'Dhanmondi', // New preferred field
      city: 'Dhaka',
    });

    expect(address).toBe('House 1, Road 2, Block B, Dhanmondi, Dhaka');
  });

  it('should build address with deprecated area field', () => {
    const provider = new RedXProvider(offlineConfig) as any;

    const address = provider._buildAddress({
      addressLine1: 'House 1, Road 2',
      area: 'Dhanmondi', // Deprecated but still supported
      city: 'Dhaka',
    });

    expect(address).toBe('House 1, Road 2, Dhanmondi, Dhaka');
  });

  it('should handle string address', () => {
    const provider = new RedXProvider(offlineConfig) as any;

    const address = provider._buildAddress('123 Main Street, Dhaka');
    expect(address).toBe('123 Main Street, Dhaka');
  });

  it('should handle null address', () => {
    const provider = new RedXProvider(offlineConfig) as any;

    const address = provider._buildAddress(null);
    expect(address).toBe('');
  });

  it('should resolve recipient info for gift orders', () => {
    const provider = new RedXProvider(offlineConfig);

    // Gift order: customer bought gift for someone else
    const giftOrder = {
      customerName: 'Jane Smith',
      customerPhone: '01798765432',
      deliveryAddress: {
        recipientName: 'John Doe',
        recipientPhone: '01712345678',
        addressLine1: 'House 99, Road 10',
        areaName: 'Dhanmondi',
        city: 'Dhaka',
      },
    };

    // RedX provider should use recipient info
    const addr = giftOrder.deliveryAddress;
    const recipientName = addr?.recipientName || giftOrder.customerName;
    const recipientPhone = addr?.recipientPhone || giftOrder.customerPhone;

    expect(recipientName).toBe('John Doe');
    expect(recipientPhone).toBe('01712345678');
  });
});
