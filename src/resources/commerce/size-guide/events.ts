/**
 * Size Guide Domain Events
 *
 * Events emitted by the size guide module for lifecycle tracking.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface SizeGuideCreatedPayload {
  sizeGuideId: string;
  name: string;
  slug: string;
  measurementUnit?: 'inches' | 'cm';
  isActive?: boolean;
}

interface SizeGuideUpdatedPayload {
  sizeGuideId: string;
  changes?: Record<string, unknown>;
}

interface SizeGuideDeletedPayload {
  sizeGuideId: string;
  slug: string;
  name?: string;
}

// --- Event Definitions ---

export const SizeGuideCreated = defineEvent<SizeGuideCreatedPayload>({
  name: 'size-guide:created',
  description: 'Emitted when a new size guide template is created',
  schema: {
    type: 'object',
    required: ['sizeGuideId', 'name', 'slug'],
    properties: {
      sizeGuideId: { type: 'string', description: 'Size guide ID' },
      name: { type: 'string', description: 'Size guide name' },
      slug: { type: 'string', description: 'URL-friendly slug' },
      measurementUnit: {
        type: 'string',
        enum: ['inches', 'cm'],
        description: 'Unit of measurement',
      },
      isActive: { type: 'boolean', description: 'Active status' },
    },
  },
});

export const SizeGuideUpdated = defineEvent<SizeGuideUpdatedPayload>({
  name: 'size-guide:updated',
  description: 'Emitted when a size guide template is updated',
  schema: {
    type: 'object',
    required: ['sizeGuideId'],
    properties: {
      sizeGuideId: { type: 'string', description: 'Size guide ID' },
      changes: {
        type: 'object',
        description: 'Fields that were updated',
      },
    },
  },
});

export const SizeGuideDeleted = defineEvent<SizeGuideDeletedPayload>({
  name: 'size-guide:deleted',
  description: 'Emitted when a size guide template is deleted (soft delete)',
  schema: {
    type: 'object',
    required: ['sizeGuideId', 'slug'],
    properties: {
      sizeGuideId: { type: 'string', description: 'Size guide ID' },
      slug: { type: 'string', description: 'Size guide slug' },
      name: { type: 'string', description: 'Size guide name' },
    },
  },
});

// --- Registry ---

eventRegistry.register(SizeGuideCreated);
eventRegistry.register(SizeGuideUpdated);
eventRegistry.register(SizeGuideDeleted);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'size-guide:created': SizeGuideCreated,
  'size-guide:updated': SizeGuideUpdated,
  'size-guide:deleted': SizeGuideDeleted,
};

export const handlers: Record<string, never> = {
  // Size guide module doesn't subscribe to other events yet
  // Can add handlers here if needed in the future
};
