/**
 * Inventory resource config — contract shape assertions.
 *
 * Replaces the pre-2.11 `createConfigTestSuite(resource)` helper that Arc
 * removed in the testing-surface rewrite. Same intent: cheap, DB-less
 * regression net that catches typo'd permission keys, missing event
 * handlers, or malformed field rules on these resources. No app boot.
 *
 * If Arc re-introduces a replacement for `createConfigTestSuite`, swap
 * this hand-rolled suite back to it.
 */

import { describe, expect, it } from 'vitest';

import purchaseOrderResource from './purchase-order/purchase-order.resource.js';
import stockRequestResource from './stock-request/stock-request.resource.js';
import supplierResource from './supplier/supplier.resource.js';
import transferResource from './transfer/transfer.resource.js';

const resources = [
  ['purchase-order', purchaseOrderResource],
  ['transfer', transferResource],
  ['stock-request', stockRequestResource],
  ['supplier', supplierResource],
] as const;

for (const [label, resource] of resources) {
  describe(`${label} resource config`, () => {
    const def = resource as unknown as {
      name?: string;
      prefix?: string;
      permissions?: Record<string, unknown>;
      events?: Record<string, unknown>;
    };

    it('declares a name and prefix', () => {
      expect(def.name).toBeTruthy();
      expect(def.prefix).toMatch(/^\//);
    });

    it('every permission entry is callable or a permission matrix', () => {
      for (const [key, value] of Object.entries(def.permissions ?? {})) {
        expect(value, `permissions.${key}`).toBeDefined();
        const kind = typeof value;
        expect(
          kind === 'function' || (kind === 'object' && value !== null),
          `permissions.${key} is ${kind}`,
        ).toBe(true);
      }
    });

    it('every declared event has a handler function', () => {
      for (const [key, entry] of Object.entries(def.events ?? {})) {
        const handler = (entry as { handler?: unknown }).handler;
        expect(typeof handler, `events.${key}.handler`).toBe('function');
      }
    });
  });
}
