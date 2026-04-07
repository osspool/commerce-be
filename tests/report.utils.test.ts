import { describe, it, expect } from 'vitest';
import {
  parseBuckets,
  parseSkuRefs,
  parsePeriodDays,
} from '../src/resources/inventory/warehouse/report.utils.js';

describe('report.utils', () => {
  describe('parseBuckets', () => {
    it('returns defaults when undefined', () => {
      expect(parseBuckets(undefined)).toEqual([30, 60, 90]);
    });
    it('returns defaults when empty string', () => {
      expect(parseBuckets('')).toEqual([30, 60, 90]);
    });
    it('parses comma-separated', () => {
      expect(parseBuckets('15,45,90')).toEqual([15, 45, 90]);
    });
    it('sorts ascending', () => {
      expect(parseBuckets('90,15,45')).toEqual([15, 45, 90]);
    });
    it('drops non-positive and non-numeric', () => {
      expect(parseBuckets('10,abc,-5,0,20')).toEqual([10, 20]);
    });
    it('falls back to defaults if all invalid', () => {
      expect(parseBuckets('abc,-1')).toEqual([30, 60, 90]);
    });
  });

  describe('parseSkuRefs', () => {
    it('returns [] when undefined', () => {
      expect(parseSkuRefs(undefined)).toEqual([]);
    });
    it('parses and trims', () => {
      expect(parseSkuRefs('a, b ,c')).toEqual(['a', 'b', 'c']);
    });
    it('dedupes', () => {
      expect(parseSkuRefs('a,b,a')).toEqual(['a', 'b']);
    });
    it('drops empties', () => {
      expect(parseSkuRefs('a,,b,')).toEqual(['a', 'b']);
    });
  });

  describe('parsePeriodDays', () => {
    it('defaults to 30', () => {
      expect(parsePeriodDays(undefined)).toBe(30);
    });
    it('parses positive integers', () => {
      expect(parsePeriodDays('60')).toBe(60);
    });
    it('floors floats', () => {
      expect(parsePeriodDays('45.7')).toBe(45);
    });
    it('rejects zero/negative', () => {
      expect(parsePeriodDays('0')).toBe(30);
      expect(parsePeriodDays('-5')).toBe(30);
    });
    it('rejects garbage', () => {
      expect(parsePeriodDays('abc')).toBe(30);
    });
    it('honors custom fallback', () => {
      expect(parsePeriodDays(undefined, 7)).toBe(7);
    });
  });
});
