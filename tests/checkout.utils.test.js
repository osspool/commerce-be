import { describe, it, expect } from 'vitest';
import {
  calculateOrderParcelMetrics,
  calculateOrderParcelMetricsFromLineItems,
  getCartItemVariantSku,
  resolvePosItemShipping,
  resolveCartItemShipping,
} from '#modules/sales/orders/checkout.utils.js';

describe('checkout.utils (order parcel metrics)', () => {
  it('resolves variant SKU from direct variantSku', () => {
    const sku = getCartItemVariantSku(null, 'SKU-M-RED');
    expect(sku).toBe('SKU-M-RED');
  });

  it('calculates order parcel metrics using variant overrides when available', () => {
    const product = {
      shipping: {
        weightGrams: 200,
        dimensionsCm: { length: 10, width: 10, height: 2 },
      },
      variants: [
        {
          sku: 'SKU-M',
          attributes: { size: 'M' },
          shipping: {
            weightGrams: 300,
            dimensionsCm: { length: 12, width: 10, height: 3 },
          },
        },
      ],
    };

    const metrics = calculateOrderParcelMetrics([
      { product, quantity: 2, variantSku: 'SKU-M' },
    ]);

    expect(metrics).toEqual({
      weightGrams: 600,
      dimensionsCm: { length: 12, width: 10, height: 6 },
      missingWeightItems: 0,
      missingDimensionItems: 0,
    });
  });

  it('returns unknown weight/dimensions when any cart item is missing required shipping attributes', () => {
    const productWithWeightOnly = {
      shipping: { weightGrams: 100 },
    };
    const productWithDimsOnly = {
      shipping: { dimensionsCm: { length: 10, width: 5, height: 2 } },
    };

    const metrics = calculateOrderParcelMetrics([
      { product: productWithWeightOnly, quantity: 1 },
      { product: productWithDimsOnly, quantity: 3 },
    ]);

    expect(metrics.weightGrams).toBeUndefined();
    expect(metrics.dimensionsCm).toBeUndefined();
    expect(metrics.missingWeightItems).toBe(3);
    expect(metrics.missingDimensionItems).toBe(1);
  });

  it('falls back to product shipping when variant shipping is absent', () => {
    const product = {
      shipping: { weightGrams: 250, dimensionsCm: { length: 8, width: 6, height: 1 } },
      variants: [
        {
          sku: 'SKU-BLK',
          attributes: { color: 'Black' },
          // No shipping override
        },
      ],
    };

    const resolved = resolveCartItemShipping(product, 'SKU-BLK');
    expect(resolved.variantSku).toBe('SKU-BLK');
    expect(resolved.weightGrams).toBe(250);
    expect(resolved.dimensionsCm).toEqual({ length: 8, width: 6, height: 1 });
  });

  it('calculates parcel metrics from POS line items using variantSku', () => {
    const product = {
      shipping: {
        weightGrams: 100,
        dimensionsCm: { length: 10, width: 8, height: 2 },
      },
      variants: [
        {
          sku: 'SKU-L',
          attributes: { size: 'L' },
          shipping: { weightGrams: 250, dimensionsCm: { length: 12, width: 8, height: 3 } },
        },
      ],
    };

    const resolved = resolvePosItemShipping(product, 'SKU-L');
    expect(resolved.weightGrams).toBe(250);

    const metrics = calculateOrderParcelMetricsFromLineItems([
      { product, variantSku: 'SKU-L', quantity: 2 },
      { product, variantSku: null, quantity: 1 },
    ]);

    expect(metrics.weightGrams).toBe(600);
    expect(metrics.dimensionsCm).toEqual({ length: 12, width: 8, height: 8 });
    expect(metrics.missingWeightItems).toBe(0);
    expect(metrics.missingDimensionItems).toBe(0);
  });
});
