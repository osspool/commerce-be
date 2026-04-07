/**
 * Auth Module Events
 */

import { publish } from '#lib/events/arcEvents.js';
import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface UserCreatedPayload {
  userId: string;
  email: string;
  name?: string;
  role?: string[];
}

interface UserLoginPayload {
  userId: string;
  email: string;
  timestamp?: string;
}

interface UserUpdatedPayload {
  userId: string;
  changes?: Record<string, unknown>;
}

interface UserDeletedPayload {
  userId: string;
  email?: string;
}

interface PasswordResetPayload {
  userId: string;
  email?: string;
}

// --- Event Definitions ---

export const UserCreated = defineEvent<UserCreatedPayload>({
  name: 'user:created',
  description: 'Emitted when a new user is created',
  schema: {
    type: 'object',
    required: ['userId', 'email'],
    properties: {
      userId: { type: 'string', format: 'objectId' },
      email: { type: 'string', format: 'email' },
      name: { type: 'string' },
      role: { type: 'array', items: { type: 'string' } },
    },
  },
});

export const UserLogin = defineEvent<UserLoginPayload>({
  name: 'user:login',
  description: 'Emitted when user successfully logs in',
  schema: {
    type: 'object',
    required: ['userId', 'email'],
    properties: {
      userId: { type: 'string' },
      email: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
});

export const UserUpdated = defineEvent<UserUpdatedPayload>({
  name: 'user:updated',
  description: 'Emitted when user profile is updated',
  schema: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string' },
      changes: { type: 'object' },
    },
  },
});

export const UserDeleted = defineEvent<UserDeletedPayload>({
  name: 'user:deleted',
  description: 'Emitted when user is deleted',
  schema: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string' },
      email: { type: 'string' },
    },
  },
});

export const UserPasswordReset = defineEvent<PasswordResetPayload>({
  name: 'user:password.reset',
  description: 'Emitted when user resets password',
  schema: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string' },
      email: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(UserCreated);
eventRegistry.register(UserLogin);
eventRegistry.register(UserUpdated);
eventRegistry.register(UserDeleted);
eventRegistry.register(UserPasswordReset);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'user:created': UserCreated,
  'user:login': UserLogin,
  'user:updated': UserUpdated,
  'user:deleted': UserDeleted,
  'user:password.reset': UserPasswordReset,
};

export const handlers: Record<string, unknown> = {};

// Helper functions
export function emitUserCreated(payload: UserCreatedPayload): void {
  void publish('user:created', payload);
}

export function emitUserLogin(payload: UserLoginPayload): void {
  void publish('user:login', payload);
}

export function emitUserUpdated(payload: UserUpdatedPayload): void {
  void publish('user:updated', payload);
}

export function emitUserDeleted(payload: UserDeletedPayload): void {
  void publish('user:deleted', payload);
}

export function emitPasswordReset(payload: PasswordResetPayload): void {
  void publish('user:password.reset', payload);
}
