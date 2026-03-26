/**
 * Access Control — AC + Role Definitions for Commerce ERP
 *
 * Branch roles map to Better Auth organization roles.
 * Each branch is a BA organization; staff are org members.
 *
 * 6 org-level roles:
 *   branch_manager  — Full branch control
 *   inventory_staff  — Stock operations
 *   cashier          — POS & order operations
 *   stock_receiver   — Receive transfers
 *   stock_requester  — Request stock from head office
 *   viewer           — Read-only access
 */

import { createAccessControl } from 'better-auth/plugins/access';

export const statements = {
  organization: ['read', 'update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'read', 'cancel'],
  inventory: ['create', 'read', 'update', 'delete'],
  order: ['create', 'read', 'update', 'delete'],
  transaction: ['create', 'read', 'update', 'delete'],
  product: ['create', 'read', 'update', 'delete'],
  pos: ['create', 'read'],
  finance: ['read', 'update'],
  transfer: ['create', 'read', 'update'],
};

export const ac = createAccessControl(statements);

/**
 * branch_manager — Full branch control. Manages all operations.
 */
export const branch_manager = ac.newRole({
  organization: ['read', 'update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'read', 'cancel'],
  inventory: ['create', 'read', 'update', 'delete'],
  order: ['create', 'read', 'update', 'delete'],
  transaction: ['create', 'read', 'update', 'delete'],
  product: ['create', 'read', 'update', 'delete'],
  pos: ['create', 'read'],
  finance: ['read', 'update'],
  transfer: ['create', 'read', 'update'],
});

/**
 * inventory_staff — Stock operations (receive, adjust, request).
 */
export const inventory_staff = ac.newRole({
  organization: ['read'],
  member: ['read'],
  invitation: [],
  inventory: ['create', 'read', 'update', 'delete'],
  order: ['read'],
  transaction: ['read'],
  product: ['read'],
  pos: [],
  finance: [],
  transfer: ['create', 'read', 'update'],
});

/**
 * cashier — POS operations, order creation.
 */
export const cashier = ac.newRole({
  organization: ['read'],
  member: ['read'],
  invitation: [],
  inventory: ['read'],
  order: ['create', 'read', 'update'],
  transaction: ['create', 'read'],
  product: ['read'],
  pos: ['create', 'read'],
  finance: [],
  transfer: ['read'],
});

/**
 * stock_receiver — Receive transfers only.
 */
export const stock_receiver = ac.newRole({
  organization: ['read'],
  member: [],
  invitation: [],
  inventory: ['read', 'update'],
  order: [],
  transaction: [],
  product: ['read'],
  pos: [],
  finance: [],
  transfer: ['read', 'update'],
});

/**
 * stock_requester — Can request stock from head office.
 */
export const stock_requester = ac.newRole({
  organization: ['read'],
  member: [],
  invitation: [],
  inventory: ['read'],
  order: [],
  transaction: [],
  product: ['read'],
  pos: [],
  finance: [],
  transfer: ['create', 'read'],
});

/**
 * viewer — Read-only access.
 */
export const viewer = ac.newRole({
  organization: ['read'],
  member: ['read'],
  invitation: ['read'],
  inventory: ['read'],
  order: ['read'],
  transaction: ['read'],
  product: ['read'],
  pos: ['read'],
  finance: ['read'],
  transfer: ['read'],
});
