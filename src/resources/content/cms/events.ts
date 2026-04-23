/**
 * CMS Domain Events
 *
 * Events emitted during CMS page lifecycle.
 */

import type { EventDefinition } from '@classytic/arc';
import { defineEvent } from '@classytic/arc/events';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface CmsPageCreatedPayload {
  pageId: string;
  slug: string;
  name?: string;
  status: 'draft' | 'published' | 'archived';
}

interface CmsPageUpdatedPayload {
  pageId: string;
  slug: string;
  oldStatus?: string;
  newStatus?: string;
}

interface CmsPagePublishedPayload {
  pageId: string;
  slug: string;
  name?: string;
  publishedAt?: string;
}

interface CmsPageDeletedPayload {
  pageId: string;
  slug: string;
}

// --- Event Definitions ---

export const CmsPageCreated = defineEvent<CmsPageCreatedPayload>({
  name: 'cms:page-created',
  description: 'Emitted when a new CMS page is created',
  schema: {
    type: 'object',
    required: ['pageId', 'slug', 'status'],
    properties: {
      pageId: { type: 'string', description: 'Page ID' },
      slug: { type: 'string', description: 'Page slug' },
      name: { type: 'string', description: 'Page name' },
      status: { type: 'string', enum: ['draft', 'published', 'archived'], description: 'Page status' },
    },
  },
});

export const CmsPageUpdated = defineEvent<CmsPageUpdatedPayload>({
  name: 'cms:page-updated',
  description: 'Emitted when a CMS page is updated',
  schema: {
    type: 'object',
    required: ['pageId', 'slug'],
    properties: {
      pageId: { type: 'string', description: 'Page ID' },
      slug: { type: 'string', description: 'Page slug' },
      oldStatus: { type: 'string', description: 'Previous status' },
      newStatus: { type: 'string', description: 'New status' },
    },
  },
});

export const CmsPagePublished = defineEvent<CmsPagePublishedPayload>({
  name: 'cms:page-published',
  description: 'Emitted when a CMS page is published',
  schema: {
    type: 'object',
    required: ['pageId', 'slug'],
    properties: {
      pageId: { type: 'string', description: 'Page ID' },
      slug: { type: 'string', description: 'Page slug' },
      name: { type: 'string', description: 'Page name' },
      publishedAt: { type: 'string', format: 'date-time', description: 'Publication timestamp' },
    },
  },
});

export const CmsPageDeleted = defineEvent<CmsPageDeletedPayload>({
  name: 'cms:page-deleted',
  description: 'Emitted when a CMS page is deleted',
  schema: {
    type: 'object',
    required: ['pageId', 'slug'],
    properties: {
      pageId: { type: 'string', description: 'Page ID' },
      slug: { type: 'string', description: 'Page slug' },
    },
  },
});

// --- Registry ---

eventRegistry.register(CmsPageCreated);
eventRegistry.register(CmsPageUpdated);
eventRegistry.register(CmsPagePublished);
eventRegistry.register(CmsPageDeleted);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'cms:page-created': CmsPageCreated,
  'cms:page-updated': CmsPageUpdated,
  'cms:page-published': CmsPagePublished,
  'cms:page-deleted': CmsPageDeleted,
};

export const handlers = {
  // CMS module doesn't subscribe to events yet
};
