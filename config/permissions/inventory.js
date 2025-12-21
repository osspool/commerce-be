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

  /**
   * Record stock purchases from suppliers
   * Only head office can add new stock to the system
   */
  purchase: groups.warehouseStaff,

  /**
   * View purchase history
   */
  purchaseView: [roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER],

  // ============================================
  // TRANSFERS (Challan Operations)
  // ============================================

  /**
   * Create new stock transfer (head office only)
   */
  transferCreate: groups.warehouseStaff,

  /**
   * Approve transfer for dispatch
   */
  transferApprove: groups.warehouseStaff,

  /**
   * Dispatch transfer (decrements head office stock)
   */
  transferDispatch: groups.warehouseStaff,

  /**
   * Receive transfer at sub-branch (increments stock)
   * Store managers can receive at their branch
   */
  transferReceive: [roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER],

  /**
   * View transfer/challan details
   */
  transferView: groups.inventoryStaff,

  /**
   * Cancel a pending transfer
   */
  transferCancel: groups.warehouseStaff,

  // ============================================
  // ADJUSTMENTS (Any Branch)
  // ============================================

  /**
   * Adjust stock quantity (damaged, lost, recount)
   * Store managers can adjust at their branch
   */
  adjust: groups.storeStaff,

  /**
   * Bulk import/adjustment
   */
  bulkAdjust: [roles.ADMIN, roles.SUPERADMIN],

  // ============================================
  // VIEW OPERATIONS
  // ============================================

  /**
   * View stock levels
   */
  view: groups.storeStaff,

  /**
   * View stock across all branches
   */
  viewAll: groups.adminOnly,

  /**
   * View low stock alerts
   */
  alerts: groups.storeStaff,

  /**
   * View stock movement audit trail
   */
  movements: groups.storeStaff,

  /**
   * View all movements across branches
   */
  movementsAll: groups.adminOnly,

  // ============================================
  // BRANCH MANAGEMENT
  // ============================================

  /**
   * Set head office branch
   */
  setHeadOffice: [roles.SUPERADMIN],

  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================

  /**
   * Create stock request from sub-branch
   * Store managers can request stock for their branch
   */
  stockRequestCreate: groups.inventoryStaff,

  /**
   * View stock requests
   * - Store managers: their branch requests only
   * - Admin/Warehouse: all requests
   */
  stockRequestView: groups.inventoryStaff,

  /**
   * Approve/reject stock requests (head office only)
   */
  stockRequestApprove: groups.warehouseStaff,

  /**
   * Fulfill stock requests (creates transfer)
   */
  stockRequestFulfill: groups.warehouseStaff,

  /**
   * Cancel stock requests
   * - Requester can cancel their own pending requests
   * - Admin can cancel any request
   */
  stockRequestCancel: groups.inventoryStaff,

  // ============================================
  // SUB-BRANCH TRANSFERS
  // ============================================

  /**
   * Create sub-branch to sub-branch transfers
   * Requires explicit permission (not typical flow)
   */
  subBranchTransfer: [roles.ADMIN, roles.SUPERADMIN],

  /**
   * Return stock from sub-branch to head office
   */
  returnToHead: [roles.ADMIN, roles.SUPERADMIN],
};

export default inventory;
