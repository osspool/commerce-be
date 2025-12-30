/**
 * Auth Module Events
 */

import { eventBus } from '#core/events/EventBus.js';

export const events = {
  'user:created': {
    module: 'auth',
    description: 'Emitted when a new user is created',
    schema: {
      type: 'object',
      required: ['userId', 'email'],
      properties: {
        userId: { type: 'string', format: 'objectId' },
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
        roles: { type: 'array', items: { type: 'string' } }
      }
    }
  },

  'user:login': {
    module: 'auth',
    description: 'Emitted when user successfully logs in',
    schema: {
      type: 'object',
      required: ['userId', 'email'],
      properties: {
        userId: { type: 'string' },
        email: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' }
      }
    }
  },

  'user:updated': {
    module: 'auth',
    description: 'Emitted when user profile is updated',
    schema: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string' },
        changes: { type: 'object' }
      }
    }
  },

  'user:deleted': {
    module: 'auth',
    description: 'Emitted when user is deleted',
    schema: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string' },
        email: { type: 'string' }
      }
    }
  },

  'user:password.reset': {
    module: 'auth',
    description: 'Emitted when user resets password',
    schema: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string' },
        email: { type: 'string' }
      }
    }
  }
};

export const handlers = {};

// Helper functions
export function emitUserCreated(payload) {
  eventBus.emit('user:created', payload);
}

export function emitUserLogin(payload) {
  eventBus.emit('user:login', payload);
}

export function emitUserUpdated(payload) {
  eventBus.emit('user:updated', payload);
}

export function emitUserDeleted(payload) {
  eventBus.emit('user:deleted', payload);
}

export function emitPasswordReset(payload) {
  eventBus.emit('user:password.reset', payload);
}
