/**
 * Branch Module Events
 *
 * Events for branch/location management.
 * Critical for inventory systems that depend on branch-level stock.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface BranchCreatedPayload {
  branchId: string;
  name: string;
  code: string;
  isDefault?: boolean;
  isActive?: boolean;
}

interface BranchUpdatedPayload {
  branchId: string;
  changes?: Record<string, unknown>;
}

interface BranchDeletedPayload {
  branchId: string;
  code: string;
  name?: string;
}

interface BranchDefaultChangedPayload {
  newDefaultBranchId: string;
  oldDefaultBranchId: string;
  changedBy?: string;
}

// --- Event Definitions ---

export const BranchCreated = defineEvent<BranchCreatedPayload>({
  name: 'branch:created',
  description: 'Emitted when a new branch/location is created',
  schema: {
    type: 'object',
    required: ['branchId', 'name', 'code'],
    properties: {
      branchId: { type: 'string' },
      name: { type: 'string' },
      code: { type: 'string', description: 'Unique branch code' },
      isDefault: { type: 'boolean' },
      isActive: { type: 'boolean' },
    },
  },
});

export const BranchUpdated = defineEvent<BranchUpdatedPayload>({
  name: 'branch:updated',
  description: 'Emitted when branch details are updated',
  schema: {
    type: 'object',
    required: ['branchId'],
    properties: {
      branchId: { type: 'string' },
      changes: { type: 'object', description: 'Changed fields' },
    },
  },
});

export const BranchDeleted = defineEvent<BranchDeletedPayload>({
  name: 'branch:deleted',
  description: 'Emitted when a branch is deleted',
  schema: {
    type: 'object',
    required: ['branchId', 'code'],
    properties: {
      branchId: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
    },
  },
});

export const BranchDefaultChanged = defineEvent<BranchDefaultChangedPayload>({
  name: 'branch:default-changed',
  description: 'Emitted when default branch is changed',
  schema: {
    type: 'object',
    required: ['newDefaultBranchId', 'oldDefaultBranchId'],
    properties: {
      newDefaultBranchId: { type: 'string' },
      oldDefaultBranchId: { type: 'string' },
      changedBy: { type: 'string', description: 'Admin user ID' },
    },
  },
});

// --- Registry ---

eventRegistry.register(BranchCreated);
eventRegistry.register(BranchUpdated);
eventRegistry.register(BranchDeleted);
eventRegistry.register(BranchDefaultChanged);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'branch:created': BranchCreated,
  'branch:updated': BranchUpdated,
  'branch:deleted': BranchDeleted,
  'branch:default-changed': BranchDefaultChanged,
};

export const handlers: Record<string, never> = {
  // Events this module subscribes to
  // (Branch is typically a foundational module with no external dependencies)
};
