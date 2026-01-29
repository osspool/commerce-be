import { requireRoles } from '@classytic/arc/permissions';
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
export const inventory = {
  // ============================================
  // PURCHASES (Head Office Only)
  // ============================================

  /** Record stock purchases from suppliers */
  purchase: requireRoles(groups.warehouseStaff),

  /** View purchase history */
  purchaseView: requireRoles([...groups.inventoryStaff, ...groups.financeStaff]),

  /** Approve purchase invoices */
  purchaseApprove: requireRoles(groups.warehouseStaff),

  /** Receive stock for purchases */
  purchaseReceive: requireRoles(groups.warehouseStaff),

  /** Record supplier payments */
  purchasePay: requireRoles(groups.financeStaff),

  /** Cancel draft/approved purchases */
  purchaseCancel: requireRoles(groups.warehouseStaff),

  // ============================================
  // SUPPLIERS
  // ============================================

  /** Create/update suppliers */
  supplierManage: requireRoles(groups.warehouseStaff),

  /** View suppliers */
  supplierView: requireRoles(groups.inventoryStaff),

  // ============================================
  // TRANSFERS (Challan Operations)
  // ============================================

  /** Create new stock transfer (head office only) */
  transferCreate: requireRoles(groups.warehouseStaff),

  /** Approve transfer for dispatch */
  transferApprove: requireRoles(groups.warehouseStaff),

  /** Dispatch transfer (decrements head office stock) */
  transferDispatch: requireRoles(groups.warehouseStaff),

  /** Receive transfer at sub-branch (increments stock) */
  transferReceive: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER]),

  /** View transfer/challan details */
  transferView: requireRoles(groups.inventoryStaff),

  /** Cancel a pending transfer */
  transferCancel: requireRoles(groups.warehouseStaff),

  // ============================================
  // ADJUSTMENTS (Any Branch)
  // ============================================

  /** Adjust stock quantity (damaged, lost, recount) */
  adjust: requireRoles(groups.storeStaff),

  /** Bulk import/adjustment */
  bulkAdjust: requireRoles([roles.ADMIN, roles.SUPERADMIN]),

  // ============================================
  // VIEW OPERATIONS
  // ============================================

  /** View stock levels */
  view: requireRoles(groups.storeStaff),

  /** View stock across all branches */
  viewAll: requireRoles(groups.adminOnly),

  /** View low stock alerts */
  alerts: requireRoles(groups.storeStaff),

  /** View stock movement audit trail */
  movements: requireRoles(groups.storeStaff),

  /** View all movements across branches */
  movementsAll: requireRoles(groups.adminOnly),

  // ============================================
  // BRANCH MANAGEMENT
  // ============================================

  /** Set head office branch */
  setHeadOffice: requireRoles([roles.SUPERADMIN]),

  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================

  /** Create stock request from sub-branch */
  stockRequestCreate: requireRoles(groups.inventoryStaff),

  /** View stock requests */
  stockRequestView: requireRoles(groups.inventoryStaff),

  /** Approve/reject stock requests (head office only) */
  stockRequestApprove: requireRoles(groups.warehouseStaff),

  /** Fulfill stock requests (creates transfer) */
  stockRequestFulfill: requireRoles(groups.warehouseStaff),

  /** Cancel stock requests */
  stockRequestCancel: requireRoles(groups.inventoryStaff),

  // ============================================
  // SUB-BRANCH TRANSFERS
  // ============================================

  /** Create sub-branch to sub-branch transfers */
  subBranchTransfer: requireRoles([roles.ADMIN, roles.SUPERADMIN]),

  /** Return stock from sub-branch to head office */
  returnToHead: requireRoles([roles.ADMIN, roles.SUPERADMIN]),
};

export default inventory;
