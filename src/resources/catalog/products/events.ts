/**
 * Product Module Events
 */

import { publish } from '#lib/events/arcEvents.js';
import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface ProductCreatedPayload {
  productId: string;
  sku?: string;
  name?: string;
  productType?: 'simple' | 'variant';
}

interface ProductUpdatedPayload {
  productId: string;
  changes?: Record<string, unknown>;
}

interface ProductDeletedPayload {
  productId: string;
  sku?: string;
}

interface ProductRestoredPayload {
  productId: string;
  sku?: string;
}

interface ProductVariantsChangedPayload {
  productId: string;
  disabledSkus?: string[];
  enabledSkus?: string[];
}

interface ProductCategoryChangedPayload {
  productId: string;
  previousCategory?: string | null;
  newCategory?: string | null;
}

interface ProductBeforePurgePayload {
  productId: string;
  snapshot?: Record<string, unknown>;
}

interface ProductPurgedPayload {
  productId: string;
  sku?: string;
  category?: string | null;
}

// --- Event Definitions ---

export const ProductCreated = defineEvent<ProductCreatedPayload>({
  name: 'product:created',
  description: 'Emitted when a new product is created',
  schema: {
    type: 'object',
    required: ['productId', 'sku'],
    properties: {
      productId: { type: 'string', format: 'objectId' },
      sku: { type: 'string' },
      name: { type: 'string' },
      productType: { type: 'string', enum: ['simple', 'variant'] },
    },
  },
});

export const ProductUpdated = defineEvent<ProductUpdatedPayload>({
  name: 'product:updated',
  description: 'Emitted when product is updated',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      changes: { type: 'object' },
    },
  },
});

export const ProductDeleted = defineEvent<ProductDeletedPayload>({
  name: 'product:deleted',
  description: 'Emitted when product is soft-deleted',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      sku: { type: 'string' },
    },
  },
});

export const ProductRestored = defineEvent<ProductRestoredPayload>({
  name: 'product:restored',
  description: 'Emitted when deleted product is restored',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      sku: { type: 'string' },
    },
  },
});

export const ProductVariantsChanged = defineEvent<ProductVariantsChangedPayload>({
  name: 'product:variants.changed',
  description: 'Emitted when product variants are updated',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      disabledSkus: { type: 'array', items: { type: 'string' } },
      enabledSkus: { type: 'array', items: { type: 'string' } },
    },
  },
});

export const ProductCategoryChanged = defineEvent<ProductCategoryChangedPayload>({
  name: 'product:category.changed',
  description: 'Emitted when a product category reference changes (for maintaining category counts, etc.)',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      previousCategory: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      newCategory: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  },
});

export const ProductBeforePurge = defineEvent<ProductBeforePurgePayload>({
  name: 'product:before.purge',
  description: 'Emitted before product is permanently deleted',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      snapshot: { type: 'object' },
    },
  },
});

export const ProductPurged = defineEvent<ProductPurgedPayload>({
  name: 'product:purged',
  description: 'Emitted after product is permanently deleted',
  schema: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string' },
      sku: { type: 'string' },
      category: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  },
});

// --- Registry ---

eventRegistry.register(ProductCreated);
eventRegistry.register(ProductUpdated);
eventRegistry.register(ProductDeleted);
eventRegistry.register(ProductRestored);
eventRegistry.register(ProductVariantsChanged);
eventRegistry.register(ProductCategoryChanged);
eventRegistry.register(ProductBeforePurge);
eventRegistry.register(ProductPurged);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'product:created': ProductCreated,
  'product:updated': ProductUpdated,
  'product:deleted': ProductDeleted,
  'product:restored': ProductRestored,
  'product:variants.changed': ProductVariantsChanged,
  'product:category.changed': ProductCategoryChanged,
  'product:before.purge': ProductBeforePurge,
  'product:purged': ProductPurged,
};

export const handlers: Record<string, never> = {};

// Helper functions (optional convenience for other modules)
export function emitProductCreated(payload: ProductCreatedPayload): void {
  void publish('product:created', payload);
}
