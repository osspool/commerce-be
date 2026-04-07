/**
 * Customer Module Events
 *
 * Event definitions and handlers for the customer domain
 */

import { publish } from '#lib/events/arcEvents.js';
import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface CustomerCreatedPayload {
  customerId: string;
  userId: string;
  name?: string;
  email?: string;
}

interface CustomerUpdatedPayload {
  customerId: string;
  changes?: Record<string, unknown>;
}

interface MembershipEnrolledPayload {
  customerId: string;
  membershipTier: string;
  enrolledAt?: string;
}

interface MembershipDeactivatedPayload {
  customerId: string;
  reason?: string;
}

interface MembershipReactivatedPayload {
  customerId: string;
  membershipTier?: string;
}

// --- Event Definitions ---

export const CustomerCreated = defineEvent<CustomerCreatedPayload>({
  name: 'customer:created',
  description: 'Emitted when a new customer is created (auto-created from order/checkout)',
  schema: {
    type: 'object',
    required: ['customerId', 'userId'],
    properties: {
      customerId: { type: 'string', format: 'objectId' },
      userId: { type: 'string', format: 'objectId' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
    },
  },
});

export const CustomerUpdated = defineEvent<CustomerUpdatedPayload>({
  name: 'customer:updated',
  description: 'Emitted when customer profile is updated',
  schema: {
    type: 'object',
    required: ['customerId'],
    properties: {
      customerId: { type: 'string', format: 'objectId' },
      changes: { type: 'object' },
    },
  },
});

export const CustomerMembershipEnrolled = defineEvent<MembershipEnrolledPayload>({
  name: 'customer:membership.enrolled',
  description: 'Emitted when customer enrolls in membership program',
  schema: {
    type: 'object',
    required: ['customerId', 'membershipTier'],
    properties: {
      customerId: { type: 'string', format: 'objectId' },
      membershipTier: { type: 'string' },
      enrolledAt: { type: 'string', format: 'date-time' },
    },
  },
});

export const CustomerMembershipDeactivated = defineEvent<MembershipDeactivatedPayload>({
  name: 'customer:membership.deactivated',
  description: 'Emitted when customer membership is deactivated',
  schema: {
    type: 'object',
    required: ['customerId'],
    properties: {
      customerId: { type: 'string', format: 'objectId' },
      reason: { type: 'string' },
    },
  },
});

export const CustomerMembershipReactivated = defineEvent<MembershipReactivatedPayload>({
  name: 'customer:membership.reactivated',
  description: 'Emitted when customer membership is reactivated',
  schema: {
    type: 'object',
    required: ['customerId'],
    properties: {
      customerId: { type: 'string', format: 'objectId' },
      membershipTier: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(CustomerCreated);
eventRegistry.register(CustomerUpdated);
eventRegistry.register(CustomerMembershipEnrolled);
eventRegistry.register(CustomerMembershipDeactivated);
eventRegistry.register(CustomerMembershipReactivated);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'customer:created': CustomerCreated,
  'customer:updated': CustomerUpdated,
  'customer:membership.enrolled': CustomerMembershipEnrolled,
  'customer:membership.deactivated': CustomerMembershipDeactivated,
  'customer:membership.reactivated': CustomerMembershipReactivated,
};

/**
 * Event Handlers
 * Events this module subscribes to from other modules
 */
export const handlers = {
  // When a user is deleted, we should handle customer cleanup
  // (Implementation would go in customer.repository.js)
  // 'user:deleted': async ({ userId }) => {
  //   // Mark customer as inactive or handle cleanup
  // }
};

/**
 * Helper: Emit customer events
 * (Used by repository/controllers)
 */
export function emitCustomerCreated(payload: CustomerCreatedPayload): void {
  void publish('customer:created', payload);
}

export function emitCustomerUpdated(payload: CustomerUpdatedPayload): void {
  void publish('customer:updated', payload);
}

export function emitMembershipEnrolled(payload: MembershipEnrolledPayload): void {
  void publish('customer:membership.enrolled', payload);
}

export function emitMembershipDeactivated(payload: MembershipDeactivatedPayload): void {
  void publish('customer:membership.deactivated', payload);
}

export function emitMembershipReactivated(payload: MembershipReactivatedPayload): void {
  void publish('customer:membership.reactivated', payload);
}
