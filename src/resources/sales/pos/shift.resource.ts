/**
 * POS Shift Resource — Arc CRUD + declarative actions + custom routes.
 *
 * CRUD (list/get/create/update/delete) via adapter.
 * Custom routes: GET /current, POST /open.
 * Actions (Stripe-style, POST /:id/action):
 *   pause, resume, cash-in, cash-out, blind-close, reconcile, close.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import {
  blindCloseAction,
  cashInAction,
  cashOutAction,
  closeShiftAction,
  getCurrentShift,
  openShift,
  pauseAction,
  reconcileAction,
  resumeAction,
} from './shift.handlers.js';
import PosShift from './shift.model.js';
import posShiftRepository from './shift.repository.js';

const shiftResource = defineResource({
  name: 'pos-shift',
  displayName: 'POS Shifts',
  tag: 'POS',
  prefix: '/pos/shifts',
  audit: true,

  adapter: createAdapter(PosShift, posShiftRepository),
  queryParser: new QueryParser({
    maxLimit: 50,
    allowedFilterFields: ['state', 'openingCashierId', 'businessDate', 'closedBy'],
    allowedSortFields: ['openedAt', 'closedAt', 'businessDate', 'createdAt'],
  }),

  permissions: {
    list: permissions.pos.access,
    get: permissions.pos.access,
    create: permissions.pos.cashierAction,
    update: permissions.pos.managerAction,
    delete: permissions.pos.managerAction,
  },

  actions: {
    pause: {
      handler: async (id, data, req) => pauseAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
    resume: {
      handler: async (id, data, req) => resumeAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
    'cash-in': {
      handler: async (id, data, req) => cashInAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
    'cash-out': {
      handler: async (id, data, req) => cashOutAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
    'blind-close': {
      handler: async (id, data, req) => blindCloseAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
    reconcile: {
      handler: async (id, data, req) => reconcileAction(id, data, req),
      permissions: permissions.pos.managerAction,
    },
    close: {
      handler: async (id, data, req) => closeShiftAction(id, data, req),
      permissions: permissions.pos.cashierAction,
    },
  },

  routes: [
    {
      method: 'GET' as const,
      path: '/current',
      summary: 'Get active shift for this branch',
      description: 'Returns the active shift (open, paused, or blind_closed) for the current branch, or null.',
      permissions: permissions.pos.access,
      raw: true,
      handler: getCurrentShift,
    },
    {
      method: 'POST' as const,
      path: '/open',
      summary: 'Open a new shift',
      description: 'Opens a new POS shift. Fails with 409 if an active shift already exists for this branch.',
      permissions: permissions.pos.cashierAction,
      raw: true,
      handler: openShift,
    },
  ],
});

export default shiftResource;
