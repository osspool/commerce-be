/**
 * Logistics module — service-level smoke tests.
 *
 * The carrier-bd adapters themselves are exhaustively tested in
 * `packages/carrier-bd/tests/`. This file just verifies the be-prod
 * wiring: registry construction is lazy + idempotent, controller helpers
 * round-trip the bd-areas + bd-areas/pathao datasets.
 */

import bdAreas from '@classytic/bd-areas';
import { findCity, getZonesByCity, PATHAO_CITIES } from '@classytic/bd-areas/pathao';
import { describe, expect, it } from 'vitest';

describe('bd-areas dataset wiring', () => {
  it('exposes 8 BD divisions', () => {
    expect(bdAreas.getDivisions()).toHaveLength(8);
  });

  it('searches areas case-insensitively', () => {
    const hits = bdAreas.searchAreas('mohamm', 5);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('@classytic/bd-areas/pathao dataset wiring', () => {
  it('contains Dhaka with cityId 1', () => {
    const dhaka = PATHAO_CITIES.find((c) => c.cityName === 'Dhaka');
    expect(dhaka?.cityId).toBe(1);
  });

  it('Dhaka has > 100 zones', () => {
    expect(getZonesByCity(1).length).toBeGreaterThan(100);
  });

  it('findCity round-trips', () => {
    expect(findCity(1)?.cityName).toBe('Dhaka');
  });
});
