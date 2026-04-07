/**
 * Category Module Events
 */

import { publish } from '#lib/events/arcEvents.js';
import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';
import categoryRepository from './category.repository.js';

// --- Payload Interfaces ---

interface CategoryCreatedPayload {
  categoryId: string;
  slug: string;
  name?: string;
}

interface CategoryUpdatedPayload {
  categoryId: string;
  changes?: Record<string, unknown>;
}

interface CategoryDeletedPayload {
  categorySlug: string;
  categoryId?: string;
}

interface ProductEventPayload {
  category?: string;
}

interface ProductCategoryChangedPayload {
  previousCategory?: string | null;
  newCategory?: string | null;
}

// --- Event Definitions ---

export const CategoryCreated = defineEvent<CategoryCreatedPayload>({
  name: 'category:created',
  description: 'Emitted when a category is created',
  schema: {
    type: 'object',
    required: ['categoryId', 'slug'],
    properties: {
      categoryId: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
    },
  },
});

export const CategoryUpdated = defineEvent<CategoryUpdatedPayload>({
  name: 'category:updated',
  description: 'Emitted when a category is updated',
  schema: {
    type: 'object',
    required: ['categoryId'],
    properties: {
      categoryId: { type: 'string' },
      changes: { type: 'object' },
    },
  },
});

export const CategoryDeleted = defineEvent<CategoryDeletedPayload>({
  name: 'category:deleted',
  description: 'Emitted when a category is deleted',
  schema: {
    type: 'object',
    required: ['categorySlug'],
    properties: {
      categorySlug: { type: 'string' },
      categoryId: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(CategoryCreated);
eventRegistry.register(CategoryUpdated);
eventRegistry.register(CategoryDeleted);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'category:created': CategoryCreated,
  'category:updated': CategoryUpdated,
  'category:deleted': CategoryDeleted,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (payload: any) => Promise<void>> = {
  /**
   * Maintain Category.productCount based on product lifecycle events.
   *
   * Rationale:
   * - Keeps cross-aggregate side effects OUT of ProductRepository
   * - Makes it easy to test category counting in isolation
   * - Keeps ProductRepository focused on persistence + emitting events
   */

  'product:created': async ({ category }: ProductEventPayload): Promise<void> => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, 1);
    } catch {
      // best effort
    }
  },

  'product:deleted': async ({ category }: ProductEventPayload): Promise<void> => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, -1);
    } catch {
      // best effort
    }
  },

  'product:restored': async ({ category }: ProductEventPayload): Promise<void> => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, 1);
    } catch {
      // best effort
    }
  },

  'product:purged': async ({ category }: ProductEventPayload): Promise<void> => {
    if (!category) return;
    try {
      await categoryRepository.updateProductCount(category, -1);
    } catch {
      // best effort
    }
  },

  'product:category.changed': async ({
    previousCategory,
    newCategory,
  }: ProductCategoryChangedPayload): Promise<void> => {
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

export function emitCategoryCreated(payload: CategoryCreatedPayload): void {
  void publish('category:created', payload);
}

export function emitCategoryUpdated(payload: CategoryUpdatedPayload): void {
  void publish('category:updated', payload);
}

export function emitCategoryDeleted(payload: CategoryDeletedPayload): void {
  void publish('category:deleted', payload);
}
