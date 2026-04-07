/**
 * Supplier Events
 *
 * Domain events emitted by the supplier submodule.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface SupplierCreatedPayload {
  supplierId: string;
  code?: string;
  name?: string;
  type?: string;
  createdBy?: string;
}

interface SupplierUpdatedPayload {
  supplierId: string;
  changes?: Record<string, unknown>;
  updatedBy?: string;
}

interface SupplierDeactivatedPayload {
  supplierId: string;
  reason?: string;
  deactivatedBy?: string;
}

// --- Event Definitions ---

export const SupplierCreated = defineEvent<SupplierCreatedPayload>({
  name: 'supplier:created',
  description: 'Supplier created',
  schema: {
    type: 'object',
    required: ['supplierId'],
    properties: {
      supplierId: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      createdBy: { type: 'string' },
    },
  },
});

export const SupplierUpdated = defineEvent<SupplierUpdatedPayload>({
  name: 'supplier:updated',
  description: 'Supplier updated',
  schema: {
    type: 'object',
    required: ['supplierId'],
    properties: {
      supplierId: { type: 'string' },
      changes: { type: 'object' },
      updatedBy: { type: 'string' },
    },
  },
});

export const SupplierDeactivated = defineEvent<SupplierDeactivatedPayload>({
  name: 'supplier:deactivated',
  description: 'Supplier deactivated',
  schema: {
    type: 'object',
    required: ['supplierId'],
    properties: {
      supplierId: { type: 'string' },
      reason: { type: 'string' },
      deactivatedBy: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(SupplierCreated);
eventRegistry.register(SupplierUpdated);
eventRegistry.register(SupplierDeactivated);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'supplier:created': SupplierCreated,
  'supplier:updated': SupplierUpdated,
  'supplier:deactivated': SupplierDeactivated,
};

export const handlers: Record<string, never> = {};

export default events;
