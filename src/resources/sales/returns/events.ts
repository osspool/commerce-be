import { defineEvent } from '@classytic/arc/events';
import { eventRegistry } from '#shared/event-registry.js';

export const ReturnCreated = defineEvent<{
  returnId: string;
  orderId: string;
  returnNumber: string;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:created',
  version: 1,
  description: 'A return request was created for a delivered order',
  schema: {
    type: 'object',
    required: ['returnId', 'orderId', 'returnNumber'],
    properties: {
      returnId: { type: 'string' },
      orderId: { type: 'string' },
      returnNumber: { type: 'string' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

export const ReturnApproved = defineEvent<{
  returnId: string;
  returnNumber: string;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:approved',
  version: 1,
  schema: {
    type: 'object',
    required: ['returnId', 'returnNumber'],
    properties: {
      returnId: { type: 'string' },
      returnNumber: { type: 'string' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

export const ReturnReceived = defineEvent<{
  returnId: string;
  returnNumber: string;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:received',
  version: 1,
  schema: {
    type: 'object',
    required: ['returnId', 'returnNumber'],
    properties: {
      returnId: { type: 'string' },
      returnNumber: { type: 'string' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

export const ReturnInspected = defineEvent<{
  returnId: string;
  returnNumber: string;
  result: string;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:inspected',
  version: 1,
  schema: {
    type: 'object',
    required: ['returnId', 'returnNumber', 'result'],
    properties: {
      returnId: { type: 'string' },
      returnNumber: { type: 'string' },
      result: { type: 'string' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

export const ReturnRefunded = defineEvent<{
  returnId: string;
  returnNumber: string;
  amount: number;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:refunded',
  version: 1,
  schema: {
    type: 'object',
    required: ['returnId', 'returnNumber', 'amount'],
    properties: {
      returnId: { type: 'string' },
      returnNumber: { type: 'string' },
      amount: { type: 'number' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

export const ReturnRejected = defineEvent<{
  returnId: string;
  returnNumber: string;
  reason: string;
  organizationId: string;
  triggeredBy?: string;
}>({
  name: 'return:rejected',
  version: 1,
  schema: {
    type: 'object',
    required: ['returnId', 'returnNumber'],
    properties: {
      returnId: { type: 'string' },
      returnNumber: { type: 'string' },
      reason: { type: 'string' },
      organizationId: { type: 'string' },
      triggeredBy: { type: 'string' },
    },
  },
});

// Register all return events in the central registry
[ReturnCreated, ReturnApproved, ReturnReceived, ReturnInspected, ReturnRefunded, ReturnRejected].forEach((event) =>
  eventRegistry.register(event),
);
