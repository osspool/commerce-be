import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseIntEnv, parseBoolean, parseDelimitedString, requiredEnv, warnIfMissing } from '../src/config/utils.js';

describe('config/utils', () => {
  describe('parseIntEnv', () => {
    it('returns parsed integer for valid string', () => {
      expect(parseIntEnv('42', 0)).toBe(42);
    });

    it('returns default for undefined', () => {
      expect(parseIntEnv(undefined, 99)).toBe(99);
    });

    it('returns default for null', () => {
      expect(parseIntEnv(null, 99)).toBe(99);
    });

    it('returns default for non-numeric string', () => {
      expect(parseIntEnv('abc', 10)).toBe(10);
    });

    it('returns default for empty string', () => {
      expect(parseIntEnv('', 5)).toBe(5);
    });

    it('parses negative numbers', () => {
      expect(parseIntEnv('-7', 0)).toBe(-7);
    });

    it('truncates floats to integer', () => {
      expect(parseIntEnv('3.14', 0)).toBe(3);
    });

    it('handles leading zeros', () => {
      expect(parseIntEnv('007', 0)).toBe(7);
    });
  });

  describe('parseBoolean', () => {
    it('returns true for "true"', () => {
      expect(parseBoolean('true')).toBe(true);
    });

    it('returns true for "TRUE" (case-insensitive)', () => {
      expect(parseBoolean('TRUE')).toBe(true);
    });

    it('returns true for "True"', () => {
      expect(parseBoolean('True')).toBe(true);
    });

    it('returns false for "false"', () => {
      expect(parseBoolean('false')).toBe(false);
    });

    it('returns false for arbitrary string', () => {
      expect(parseBoolean('yes')).toBe(false);
    });

    it('returns undefined for undefined', () => {
      expect(parseBoolean(undefined)).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(parseBoolean(null)).toBeUndefined();
    });
  });

  describe('parseDelimitedString', () => {
    it('splits comma-separated string', () => {
      expect(parseDelimitedString('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('trims whitespace', () => {
      expect(parseDelimitedString(' a , b , c ')).toEqual(['a', 'b', 'c']);
    });

    it('filters empty segments', () => {
      expect(parseDelimitedString('a,,b,')).toEqual(['a', 'b']);
    });

    it('returns empty array for undefined', () => {
      expect(parseDelimitedString(undefined)).toEqual([]);
    });

    it('returns empty array for null', () => {
      expect(parseDelimitedString(null)).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseDelimitedString('')).toEqual([]);
    });

    it('supports custom delimiter', () => {
      expect(parseDelimitedString('a|b|c', '|')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('requiredEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns the value when env var is set', () => {
      process.env.TEST_REQUIRED = 'hello';
      expect(requiredEnv('TEST_REQUIRED')).toBe('hello');
    });

    it('throws when env var is missing', () => {
      delete process.env.TEST_MISSING;
      expect(() => requiredEnv('TEST_MISSING')).toThrow('Required environment variable TEST_MISSING is missing');
    });
  });

  describe('warnIfMissing', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('logs warning when env var is missing', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      delete process.env.MISSING_VAR;
      warnIfMissing('MISSING_VAR');
      expect(spy).toHaveBeenCalledWith('MISSING_VAR is not set. Functionality related to this variable may not work.');
      spy.mockRestore();
    });

    it('does not log when env var is set', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.PRESENT_VAR = 'value';
      warnIfMissing('PRESENT_VAR');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
