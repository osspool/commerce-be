/**
 * Logistics Config Tests
 *
 * Tests that config is loaded correctly from environment variables.
 */

import { describe, it, expect } from 'vitest';

import config from '../../../config/index.js';

describe('Logistics Config', () => {
  describe('Environment-based configuration', () => {
    it('should have logistics config section', () => {
      expect(config.logistics).toBeDefined();
      expect(config.logistics.defaultProvider).toBeDefined();
      expect(config.logistics.providers).toBeDefined();
    });

    it('should have redx provider config', () => {
      const redx = (config.logistics.providers as unknown as Record<string, Record<string, unknown>>).redx;
      expect(redx).toBeDefined();
      expect(redx.apiUrl).toBeDefined();
      expect(typeof redx.isSandbox).toBe('boolean');
    });

    it('should default to redx provider', () => {
      expect(config.logistics.defaultProvider).toBe('redx');
    });

    it('should have isSandbox boolean flag', () => {
      const redx = (config.logistics.providers as unknown as Record<string, Record<string, unknown>>).redx;
      expect(typeof redx.isSandbox).toBe('boolean');
    });
  });
});
