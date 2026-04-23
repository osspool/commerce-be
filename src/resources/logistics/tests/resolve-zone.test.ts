/**
 * Zone resolver unit tests — pure function, no Mongo, no HTTP.
 *
 * Covers the match-specificity order and computeEstimate's handling
 * of flat mode, free-over-amount thresholds, and catch-all fallback.
 */

import { describe, expect, it } from 'vitest';
import { computeEstimate, resolveZone, type CheckoutLike } from '../utils/resolve-zone.js';

const dhakaArea = { internalId: 1206, districtName: 'Dhaka', divisionName: 'Dhaka' };
const chittagongArea = { internalId: 3001, districtName: 'Chittagong', divisionName: 'Chittagong' };
const coxsBazarArea = { internalId: 3500, districtName: "Cox's Bazar", divisionName: 'Chittagong' };

const seededConfig: CheckoutLike = {
  deliveryFeeSource: 'zones',
  defaultZoneCharge: 120,
  freeDeliveryThreshold: 0,
  deliveryZones: [
    { name: 'Inside Dhaka', charge: 60, codCharge: 15, match: { districts: ['Dhaka'] }, priority: 10 },
    { name: 'Outside Dhaka', charge: 120, codCharge: 20, match: {}, priority: 0 },
  ],
};

describe('resolveZone', () => {
  it('matches Dhaka to Inside Dhaka by district', () => {
    const zone = resolveZone(dhakaArea, seededConfig);
    expect(zone.name).toBe('Inside Dhaka');
    expect(zone.charge).toBe(60);
  });

  it('falls back to catch-all zone for non-matching district', () => {
    const zone = resolveZone(chittagongArea, seededConfig);
    expect(zone.name).toBe('Outside Dhaka');
    expect(zone.charge).toBe(120);
  });

  it('falls back to defaultZoneCharge when no zones are configured', () => {
    const zone = resolveZone(dhakaArea, { deliveryFeeSource: 'zones', defaultZoneCharge: 150, deliveryZones: [] });
    expect(zone.isFallback).toBe(true);
    expect(zone.charge).toBe(150);
  });

  it('prefers areaIds match over district match (specificity)', () => {
    const zone = resolveZone(dhakaArea, {
      deliveryFeeSource: 'zones',
      deliveryZones: [
        { name: 'Inside Dhaka', charge: 60, match: { districts: ['Dhaka'] } },
        { name: 'Pinned Area', charge: 40, match: { areaIds: [1206] } },
      ],
    });
    expect(zone.name).toBe('Pinned Area');
    expect(zone.charge).toBe(40);
  });

  it('prefers district match over division match', () => {
    const zone = resolveZone(coxsBazarArea, {
      deliveryFeeSource: 'zones',
      deliveryZones: [
        { name: 'Division-wide', charge: 110, match: { divisions: ['Chittagong'] } },
        { name: "Cox's Bazar District", charge: 130, match: { districts: ["Cox's Bazar"] } },
      ],
    });
    expect(zone.name).toBe("Cox's Bazar District");
  });

  it('uses priority to tie-break same-specificity zones', () => {
    const zone = resolveZone(dhakaArea, {
      deliveryFeeSource: 'zones',
      deliveryZones: [
        { name: 'Cheap', charge: 50, match: { districts: ['Dhaka'] }, priority: 1 },
        { name: 'Premium', charge: 90, match: { districts: ['Dhaka'] }, priority: 5 },
      ],
    });
    expect(zone.name).toBe('Premium');
  });

  it('ignores inactive zones', () => {
    const zone = resolveZone(dhakaArea, {
      deliveryFeeSource: 'zones',
      defaultZoneCharge: 999,
      deliveryZones: [
        { name: 'Inside Dhaka', charge: 60, match: { districts: ['Dhaka'] }, isActive: false },
      ],
    });
    expect(zone.isFallback).toBe(true);
    expect(zone.charge).toBe(999);
  });
});

describe('computeEstimate', () => {
  it('returns Dhaka zone charge plus codCharge', () => {
    const est = computeEstimate(dhakaArea, 7998, seededConfig);
    expect(est.zone).toBe('Inside Dhaka');
    expect(est.deliveryCharge).toBe(60);
    expect(est.codCharge).toBe(15);
    expect(est.totalCharge).toBe(75);
    expect(est.freeDelivery).toBe(false);
  });

  it('applies per-zone freeOverAmount threshold', () => {
    const cfg: CheckoutLike = {
      deliveryFeeSource: 'zones',
      deliveryZones: [
        { name: 'Inside Dhaka', charge: 60, codCharge: 15, freeOverAmount: 5000, match: { districts: ['Dhaka'] } },
      ],
    };
    const est = computeEstimate(dhakaArea, 7998, cfg);
    expect(est.deliveryCharge).toBe(0);
    expect(est.codCharge).toBe(0);
    expect(est.freeDelivery).toBe(true);
  });

  it('applies global freeDeliveryThreshold even when zone has no threshold', () => {
    const cfg: CheckoutLike = {
      deliveryFeeSource: 'zones',
      freeDeliveryThreshold: 5000,
      deliveryZones: [
        { name: 'Inside Dhaka', charge: 60, match: { districts: ['Dhaka'] } },
      ],
    };
    const est = computeEstimate(dhakaArea, 7998, cfg);
    expect(est.freeDelivery).toBe(true);
    expect(est.deliveryCharge).toBe(0);
  });

  it('uses flatCharge when deliveryFeeSource is flat', () => {
    const est = computeEstimate(chittagongArea, 3000, {
      deliveryFeeSource: 'flat',
      flatCharge: 80,
    });
    expect(est.zone).toBe('Flat');
    expect(est.deliveryCharge).toBe(80);
    expect(est.codCharge).toBe(0);
  });

  it('honors freeDeliveryThreshold in flat mode', () => {
    const est = computeEstimate(chittagongArea, 10000, {
      deliveryFeeSource: 'flat',
      flatCharge: 80,
      freeDeliveryThreshold: 5000,
    });
    expect(est.freeDelivery).toBe(true);
    expect(est.deliveryCharge).toBe(0);
  });
});
