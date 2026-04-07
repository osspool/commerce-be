/**
 * Cost Price Filter Tests
 *
 * Tests the filterCostPriceByRole() and canManageCostPrice() helpers
 * from the cost-price-filter middleware.
 *
 * Pure function tests — no database required.
 */

import { describe, it, expect } from 'vitest';
import {
  canManageCostPrice,
  filterCostPriceByRole,
} from '#shared/middleware/cost-price-filter.js';

// ---------------------------------------------------------------------------
// Helpers — mock user objects
// ---------------------------------------------------------------------------

interface MockUser {
  role?: string[];
  [key: string]: unknown;
}

const adminUser: MockUser = { role: ['admin'] };
const superadminUser: MockUser = { role: ['superadmin'] };
const financeUser: MockUser = { role: ['finance-manager'] };
const regularUser: MockUser = { role: ['user'] };
const staffUser: MockUser = { role: ['store-staff'] };
const multiRoleUser: MockUser = { role: ['user', 'admin'] };
const noRoleUser: MockUser = { role: [] };

// ---------------------------------------------------------------------------
// canManageCostPrice
// ---------------------------------------------------------------------------

describe('canManageCostPrice()', () => {
  it('returns true for admin', () => {
    expect(canManageCostPrice(adminUser)).toBe(true);
  });

  it('returns true for superadmin', () => {
    expect(canManageCostPrice(superadminUser)).toBe(true);
  });

  it('returns true for finance-manager', () => {
    expect(canManageCostPrice(financeUser)).toBe(true);
  });

  it('returns true for multi-role user including admin', () => {
    expect(canManageCostPrice(multiRoleUser)).toBe(true);
  });

  it('returns false for regular user', () => {
    expect(canManageCostPrice(regularUser)).toBe(false);
  });

  it('returns false for store-staff', () => {
    expect(canManageCostPrice(staffUser)).toBe(false);
  });

  it('returns false for undefined user', () => {
    expect(canManageCostPrice(undefined)).toBe(false);
  });

  it('returns false for user with empty roles', () => {
    expect(canManageCostPrice(noRoleUser)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — admin sees everything
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — admin user', () => {
  it('preserves costPrice on single product', () => {
    const product = { name: 'Widget', costPrice: 50, price: 100 };
    const result = filterCostPriceByRole(product, adminUser) as Record<string, unknown>;

    expect(result.costPrice).toBe(50);
    expect(result.price).toBe(100);
    expect(result.name).toBe('Widget');
  });

  it('preserves costPrice on variants', () => {
    const product = {
      name: 'Shirt',
      costPrice: 30,
      variants: [
        { sku: 'S-RED', costPrice: 25, price: 60 },
        { sku: 'S-BLU', costPrice: 28, price: 65 },
      ],
    };
    const result = filterCostPriceByRole(product, adminUser) as any;

    expect(result.costPrice).toBe(30);
    expect(result.variants[0].costPrice).toBe(25);
    expect(result.variants[1].costPrice).toBe(28);
  });

  it('preserves costPrice on array of products', () => {
    const products = [
      { name: 'A', costPrice: 10, price: 20 },
      { name: 'B', costPrice: 15, price: 30 },
    ];
    const result = filterCostPriceByRole(products, adminUser) as any[];

    expect(result).toHaveLength(2);
    expect(result[0].costPrice).toBe(10);
    expect(result[1].costPrice).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — regular user has costPrice stripped
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — regular user', () => {
  it('strips costPrice from single product', () => {
    const product = { name: 'Widget', costPrice: 50, price: 100 };
    const result = filterCostPriceByRole(product, regularUser) as Record<string, unknown>;

    expect(result).not.toHaveProperty('costPrice');
    expect(result.price).toBe(100);
    expect(result.name).toBe('Widget');
  });

  it('strips costPrice from variants', () => {
    const product = {
      name: 'Shirt',
      costPrice: 30,
      variants: [
        { sku: 'S-RED', costPrice: 25, price: 60 },
        { sku: 'S-BLU', costPrice: 28, price: 65 },
      ],
    };
    const result = filterCostPriceByRole(product, regularUser) as any;

    expect(result).not.toHaveProperty('costPrice');
    expect(result.variants[0]).not.toHaveProperty('costPrice');
    expect(result.variants[1]).not.toHaveProperty('costPrice');
    // Other fields remain
    expect(result.variants[0].sku).toBe('S-RED');
    expect(result.variants[0].price).toBe(60);
  });

  it('strips costPrice from array of products', () => {
    const products = [
      { name: 'A', costPrice: 10, price: 20 },
      { name: 'B', costPrice: 15, price: 30 },
    ];
    const result = filterCostPriceByRole(products, regularUser) as any[];

    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('costPrice');
    expect(result[1]).not.toHaveProperty('costPrice');
    expect(result[0].price).toBe(20);
    expect(result[1].price).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — unauthenticated (undefined user)
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — unauthenticated', () => {
  it('strips costPrice when user is undefined', () => {
    const product = { name: 'Item', costPrice: 40, price: 80 };
    const result = filterCostPriceByRole(product, undefined) as Record<string, unknown>;

    expect(result).not.toHaveProperty('costPrice');
    expect(result.price).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — null/undefined input handling
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — null/undefined input', () => {
  it('returns null for null input', () => {
    expect(filterCostPriceByRole(null, regularUser)).toBeNull();
  });

  it('returns undefined for undefined input', () => {
    expect(filterCostPriceByRole(undefined, regularUser)).toBeUndefined();
  });

  it('returns null for null input with admin user', () => {
    expect(filterCostPriceByRole(null, adminUser)).toBeNull();
  });

  it('handles empty array', () => {
    const result = filterCostPriceByRole([], regularUser);
    expect(result).toEqual([]);
  });

  it('handles primitive values unchanged', () => {
    expect(filterCostPriceByRole(42, regularUser)).toBe(42);
    expect(filterCostPriceByRole('hello', regularUser)).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — Mongoose document simulation (toObject)
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — Mongoose-like documents', () => {
  it('calls toObject() on document-like objects', () => {
    const doc = {
      name: 'MongooseDoc',
      costPrice: 100,
      price: 200,
      toObject() {
        return { name: this.name, costPrice: this.costPrice, price: this.price };
      },
    };

    const result = filterCostPriceByRole(doc, regularUser) as any;
    expect(result).not.toHaveProperty('costPrice');
    expect(result.price).toBe(200);
  });

  it('calls toObject() on variant sub-documents', () => {
    const product = {
      name: 'Doc',
      costPrice: 50,
      variants: [
        {
          sku: 'V1',
          costPrice: 30,
          toObject() {
            return { sku: this.sku, costPrice: this.costPrice };
          },
        },
      ],
      toObject() {
        return {
          name: this.name,
          costPrice: this.costPrice,
          variants: this.variants,
        };
      },
    };

    const result = filterCostPriceByRole(product, regularUser) as any;
    expect(result).not.toHaveProperty('costPrice');
    expect(result.variants[0]).not.toHaveProperty('costPrice');
    expect(result.variants[0].sku).toBe('V1');
  });

  it('preserves costPrice on toObject() for admin', () => {
    const doc = {
      costPrice: 100,
      price: 200,
      toObject() {
        return { costPrice: this.costPrice, price: this.price };
      },
    };

    const result = filterCostPriceByRole(doc, adminUser) as any;
    expect(result.costPrice).toBe(100);
    expect(result.price).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// filterCostPriceByRole — product without costPrice (no-op)
// ---------------------------------------------------------------------------

describe('filterCostPriceByRole() — product without costPrice', () => {
  it('returns product unchanged for regular user', () => {
    const product = { name: 'NoCost', price: 100 };
    const result = filterCostPriceByRole(product, regularUser) as any;

    expect(result.name).toBe('NoCost');
    expect(result.price).toBe(100);
    expect(result).not.toHaveProperty('costPrice');
  });
});
