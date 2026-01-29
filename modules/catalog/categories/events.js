/**
 * Category Module Events
 */

import { publish } from '#lib/events/arcEvents.js';
import categoryRepository from './category.repository.js';

export const events = {
  'category:created': {
    module: 'catalog/categories',
    description: 'Emitted when a category is created',
    schema: {
      type: 'object',
      required: ['categoryId', 'slug'],
      properties: {
        categoryId: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' }
      }
    }
  },

  'category:updated': {
    module: 'catalog/categories',
    description: 'Emitted when a category is updated',
    schema: {
      type: 'object',
      required: ['categoryId'],
      properties: {
        categoryId: { type: 'string' },
        changes: { type: 'object' }
      }
    }
  },

  'category:deleted': {
    module: 'catalog/categories',
    description: 'Emitted when a category is deleted',
    schema: {
      type: 'object',
      required: ['categorySlug'],
      properties: {
        categorySlug: { type: 'string' },
        categoryId: { type: 'string' }
      }
    }
  }
};

export const handlers = {
  /**
   * Maintain Category.productCount based on product lifecycle events.
   *
   * Rationale:
   * - Keeps cross-aggregate side effects OUT of ProductRepository
   * - Makes it easy to test category counting in isolation
   * - Keeps ProductRepository focused on persistence + emitting events
   */

  'product:created': async ({ category }) => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, 1);
    } catch {
      // best effort
    }
  },

  'product:deleted': async ({ category }) => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, -1);
    } catch {
      // best effort
    }
  },

  'product:restored': async ({ category }) => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, 1);
    } catch {
      // best effort
    }
  },

  'product:purged': async ({ category }) => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, -1);
    } catch {
      // best effort
    }
  },

  'product:category.changed': async ({ previousCategory, newCategory }) => {
    const prev = previousCategory || null;
    const next = newCategory || null;
    if (!prev && !next) return;

    try {
      if (prev && prev !== next) await categoryRepository.updateProductCount(prev, -1);
      if (next && prev !== next) await categoryRepository.updateProductCount(next, 1);
    } catch {
      // best effort
    }
  },
};

export function emitCategoryCreated(payload) {
  void publish('category:created', payload);
}

export function emitCategoryUpdated(payload) {
  void publish('category:updated', payload);
}

export function emitCategoryDeleted(payload) {
  void publish('category:deleted', payload);
}
