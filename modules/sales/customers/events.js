/**
 * Customer Module Events
 *
 * Event definitions and handlers for the customer domain
 */

import { eventBus } from '#core/events/EventBus.js';

/**
 * Event Definitions
 * Events emitted by the Customer module
 */
export const events = {
  'customer:created': {
    module: 'customer',
    description: 'Emitted when a new customer is created (auto-created from order/checkout)',
    schema: {
      type: 'object',
      required: ['customerId', 'userId'],
      properties: {
        customerId: { type: 'string', format: 'objectId' },
        userId: { type: 'string', format: 'objectId' },
        name: { type: 'string' },
        email: { type: 'string', format: 'email' }
      }
    }
  },

  'customer:updated': {
    module: 'customer',
    description: 'Emitted when customer profile is updated',
    schema: {
      type: 'object',
      required: ['customerId'],
      properties: {
        customerId: { type: 'string', format: 'objectId' },
        changes: { type: 'object' }
      }
    }
  },

  'customer:membership.enrolled': {
    module: 'customer',
    description: 'Emitted when customer enrolls in membership program',
    schema: {
      type: 'object',
      required: ['customerId', 'membershipTier'],
      properties: {
        customerId: { type: 'string', format: 'objectId' },
        membershipTier: { type: 'string' },
        enrolledAt: { type: 'string', format: 'date-time' }
      }
    }
  },

  'customer:membership.deactivated': {
    module: 'customer',
    description: 'Emitted when customer membership is deactivated',
    schema: {
      type: 'object',
      required: ['customerId'],
      properties: {
        customerId: { type: 'string', format: 'objectId' },
        reason: { type: 'string' }
      }
    }
  },

  'customer:membership.reactivated': {
    module: 'customer',
    description: 'Emitted when customer membership is reactivated',
    schema: {
      type: 'object',
      required: ['customerId'],
      properties: {
        customerId: { type: 'string', format: 'objectId' },
        membershipTier: { type: 'string' }
      }
    }
  }
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
export function emitCustomerCreated(payload) {
  eventBus.emit('customer:created', payload);
}

export function emitCustomerUpdated(payload) {
  eventBus.emit('customer:updated', payload);
}

export function emitMembershipEnrolled(payload) {
  eventBus.emit('customer:membership.enrolled', payload);
}

export function emitMembershipDeactivated(payload) {
  eventBus.emit('customer:membership.deactivated', payload);
}

export function emitMembershipReactivated(payload) {
  eventBus.emit('customer:membership.reactivated', payload);
}
