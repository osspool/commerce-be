import { requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { roles, groups } from './roles.js';

/**
 * Inventory Permissions
 *
 * Fine-grained access control for inventory operations.
 *
 * Permission Model:
 * - Head Office Staff: Full stock control (purchases, transfers out)
 * - Warehouse Staff: Stock handling, transfer processing
 * - Store Manager: Local adjustments, receive transfers, view stock, create requests
 * - Admin: Full access to all operations
 *
 * Key Operations:
 * - purchase: Add new stock to system (head office only)
 * - transfer.*: Inter-branch stock movements via challans
 * - stockRequest.*: Sub-branch stock requests to head office
 * - adjust: Local stock corrections (damaged, lost, recount)
 * - view: Read stock levels and movements
 */

export interface InventoryPermissions {
  // Purchases
  purchase: PermissionCheck;
  purchaseView: PermissionCheck;
  purchaseApprove: PermissionCheck;
  purchaseReceive: PermissionCheck;
  purchasePay: PermissionCheck;
  purchaseCancel: PermissionCheck;

  // Suppliers
  supplierManage: PermissionCheck;
  supplierView: PermissionCheck;

  // Transfers
  transferCreate: PermissionCheck;
  transferApprove: PermissionCheck;
  transferDispatch: PermissionCheck;
  transferReceive: PermissionCheck;
  transferView: PermissionCheck;
  transferCancel: PermissionCheck;

  // Adjustments
  adjust: PermissionCheck;
  bulkAdjust: PermissionCheck;

  // View
  view: PermissionCheck;
  viewAll: PermissionCheck;
  alerts: PermissionCheck;
  movements: PermissionCheck;
  movementsAll: PermissionCheck;

  // Branch management
  setHeadOffice: PermissionCheck;

  // Stock Requests
  stockRequestCreate: PermissionCheck;
  stockRequestView: PermissionCheck;
  stockRequestApprove: PermissionCheck;
  stockRequestFulfill: PermissionCheck;
  stockRequestCancel: PermissionCheck;

  // Sub-branch transfers
  subBranchTransfer: PermissionCheck;
  returnToHead: PermissionCheck;

  // Lot/Serial tracking (standard+)
  lotManage: PermissionCheck;
  lotView: PermissionCheck;

  // Package management (standard+)
  packageManage: PermissionCheck;
  packageView: PermissionCheck;

  // Procurement via Flow (standard+)
  procurementCreate: PermissionCheck;
  procurementApprove: PermissionCheck;
  procurementReceive: PermissionCheck;
  procurementView: PermissionCheck;

  // Replenishment rules (standard+)
  replenishmentManage: PermissionCheck;
  replenishmentView: PermissionCheck;

  // Cost layers & valuation (standard+)
  costView: PermissionCheck;

  // Traceability (enterprise)
  traceView: PermissionCheck;

  // Reports (enterprise)
  reportView: PermissionCheck;
}

export const inventory: InventoryPermissions = {
  // ============================================
  // PURCHASES (Head Office Only)
  // ============================================

  /** Record stock purchases from suppliers */
  purchase: requireRoles(groups.platformAdmin),

  /** View purchase history */
  purchaseView: requireRoles([...groups.platformAdmin, ...groups.platformAdmin]),

  /** Approve purchase invoices */
  purchaseApprove: requireRoles(groups.platformAdmin),

  /** Receive stock for purchases */
  purchaseReceive: requireRoles(groups.platformAdmin),

  /** Record supplier payments */
  purchasePay: requireRoles(groups.platformAdmin),

  /** Cancel draft/approved purchases */
  purchaseCancel: requireRoles(groups.platformAdmin),

  // ============================================
  // SUPPLIERS
  // ============================================

  /** Create/update suppliers */
  supplierManage: requireRoles(groups.platformAdmin),

  /** View suppliers */
  supplierView: requireRoles(groups.platformAdmin),

  // ============================================
  // TRANSFERS (Challan Operations)
  // ============================================

  /** Create new stock transfer (head office only) */
  transferCreate: requireRoles(groups.platformAdmin),

  /** Approve transfer for dispatch */
  transferApprove: requireRoles(groups.platformAdmin),

  /** Dispatch transfer (decrements head office stock) */
  transferDispatch: requireRoles(groups.platformAdmin),

  /** Receive transfer at sub-branch (increments stock) */
  transferReceive: requireRoles(groups.platformAdmin),

  /** View transfer/challan details */
  transferView: requireRoles(groups.platformAdmin),

  /** Cancel a pending transfer */
  transferCancel: requireRoles(groups.platformAdmin),

  // ============================================
  // ADJUSTMENTS (Any Branch)
  // ============================================

  /** Adjust stock quantity (damaged, lost, recount) */
  adjust: requireRoles(groups.platformAdmin),

  /** Bulk import/adjustment */
  bulkAdjust: requireRoles([roles.ADMIN, roles.SUPERADMIN]),

  // ============================================
  // VIEW OPERATIONS
  // ============================================

  /** View stock levels */
  view: requireRoles(groups.platformAdmin),

  /** View stock across all branches */
  viewAll: requireRoles(groups.platformAdmin),

  /** View low stock alerts */
  alerts: requireRoles(groups.platformAdmin),

  /** View stock movement audit trail */
  movements: requireRoles(groups.platformAdmin),

  /** View all movements across branches */
  movementsAll: requireRoles(groups.platformAdmin),

  // ============================================
  // BRANCH MANAGEMENT
  // ============================================

  /** Set head office branch */
  setHeadOffice: requireRoles([roles.SUPERADMIN]),

  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================

  /** Create stock request from sub-branch */
  stockRequestCreate: requireRoles(groups.platformAdmin),

  /** View stock requests */
  stockRequestView: requireRoles(groups.platformAdmin),

  /** Approve/reject stock requests (head office only) */
  stockRequestApprove: requireRoles(groups.platformAdmin),

  /** Fulfill stock requests (creates transfer) */
  stockRequestFulfill: requireRoles(groups.platformAdmin),

  /** Cancel stock requests */
  stockRequestCancel: requireRoles(groups.platformAdmin),

  // ============================================
  // SUB-BRANCH TRANSFERS
  // ============================================

  /** Create sub-branch to sub-branch transfers */
  subBranchTransfer: requireRoles([roles.ADMIN, roles.SUPERADMIN]),

  /** Return stock from sub-branch to head office */
  returnToHead: requireRoles([roles.ADMIN, roles.SUPERADMIN]),

  // ============================================
  // LOT/SERIAL TRACKING (Standard+)
  // ============================================

  /** Create/update lot/serial records */
  lotManage: requireRoles(groups.platformAdmin),

  /** View lot/serial records */
  lotView: requireRoles(groups.platformAdmin),

  // ============================================
  // PACKAGE MANAGEMENT (Standard+)
  // ============================================

  /** Create/nest/unnest packages */
  packageManage: requireRoles(groups.platformAdmin),

  /** View packages */
  packageView: requireRoles(groups.platformAdmin),

  // ============================================
  // PROCUREMENT (Standard+)
  // ============================================

  /** Create procurement orders */
  procurementCreate: requireRoles(groups.platformAdmin),

  /** Approve procurement orders */
  procurementApprove: requireRoles(groups.platformAdmin),

  /** Receive procurement items */
  procurementReceive: requireRoles(groups.platformAdmin),

  /** View procurement orders */
  procurementView: requireRoles([...groups.platformAdmin, ...groups.platformAdmin]),

  // ============================================
  // REPLENISHMENT RULES (Standard+)
  // ============================================

  /** Create/update/delete replenishment rules */
  replenishmentManage: requireRoles(groups.platformAdmin),

  /** View replenishment rules */
  replenishmentView: requireRoles(groups.platformAdmin),

  // ============================================
  // COST LAYERS & VALUATION (Standard+)
  // ============================================

  /** View cost layers and inventory valuation */
  costView: requireRoles([...groups.platformAdmin, ...groups.platformAdmin]),

  // ============================================
  // TRACEABILITY (Enterprise)
  // ============================================

  /** Trace lot/serial movement history and recall analysis */
  traceView: requireRoles(groups.platformAdmin),

  // ============================================
  // REPORTS (Enterprise)
  // ============================================

  /** View inventory reports (aging, turnover, health) */
  reportView: requireRoles([...groups.platformAdmin, ...groups.platformAdmin]),
};

export default inventory;
