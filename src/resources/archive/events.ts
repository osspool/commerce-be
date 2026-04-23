/**
 * Archive Domain Events
 *
 * Events emitted by the archive module for lifecycle tracking.
 */

import type { EventDefinition } from '@classytic/arc';
import { defineEvent } from '@classytic/arc/events';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface ArchiveCreatedPayload {
  archiveId: string;
  type: 'order' | 'transaction' | 'stock_movement';
  recordCount: number;
  sizeBytes?: number;
  filePath?: string;
  rangeFrom?: string;
  rangeTo?: string;
}

interface ArchiveDeletedPayload {
  archiveId: string;
  type?: string;
}

interface ArchivePurgedPayload {
  archiveId: string;
  filePath?: string;
  type?: string;
}

// --- Event Definitions ---

export const ArchiveCreated = defineEvent<ArchiveCreatedPayload>({
  name: 'archive:created',
  description: 'Emitted when a new archive is created (via /run endpoint)',
  schema: {
    type: 'object',
    required: ['archiveId', 'type', 'recordCount'],
    properties: {
      archiveId: { type: 'string', description: 'Archive ID' },
      type: { type: 'string', enum: ['order', 'transaction', 'stock_movement'], description: 'Archive type' },
      recordCount: { type: 'number', description: 'Number of records archived' },
      sizeBytes: { type: 'number', description: 'Archive file size in bytes' },
      filePath: { type: 'string', description: 'Path to archive file' },
      rangeFrom: { type: 'string', format: 'date-time', description: 'Archive date range start' },
      rangeTo: { type: 'string', format: 'date-time', description: 'Archive date range end' },
    },
  },
});

export const ArchiveDeleted = defineEvent<ArchiveDeletedPayload>({
  name: 'archive:deleted',
  description: 'Emitted when an archive is deleted (soft delete)',
  schema: {
    type: 'object',
    required: ['archiveId'],
    properties: {
      archiveId: { type: 'string', description: 'Archive ID' },
      type: { type: 'string', description: 'Archive type' },
    },
  },
});

export const ArchivePurged = defineEvent<ArchivePurgedPayload>({
  name: 'archive:purged',
  description: 'Emitted when an archive is permanently purged by superadmin',
  schema: {
    type: 'object',
    required: ['archiveId'],
    properties: {
      archiveId: { type: 'string', description: 'Archive ID' },
      filePath: { type: 'string', description: 'Deleted file path' },
      type: { type: 'string', description: 'Archive type' },
    },
  },
});

// --- Registry ---

eventRegistry.register(ArchiveCreated);
eventRegistry.register(ArchiveDeleted);
eventRegistry.register(ArchivePurged);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'archive:created': ArchiveCreated,
  'archive:deleted': ArchiveDeleted,
  'archive:purged': ArchivePurged,
};

export const handlers = {
  // Archive module doesn't subscribe to other events yet
  // Can add handlers here if needed in the future
};
