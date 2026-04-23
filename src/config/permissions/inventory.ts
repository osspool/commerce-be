import type { PermissionCheck } from '@classytic/arc';
import { anyOf, platformAdminOnly, requireOrgRole, superadminOnly } from '#shared/permissions.js';
import { orgGroups } from './roles.js';

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
  purchaseOrder: PermissionCheck;
  purchaseOrderView: PermissionCheck;
  purchaseApprove: PermissionCheck;
  purchaseOrderReceive: PermissionCheck;
  purchaseOrderPay: PermissionCheck;
  purchaseOrderCancel: PermissionCheck;

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

  // Quality inspection (enterprise)
  qualityView: PermissionCheck;
  qualityManage: PermissionCheck;

  // Execution tasks / scanner (enterprise)
  taskManage: PermissionCheck;
  taskExecute: PermissionCheck;

  // Dispatch / carrier / dock (enterprise)
  dispatchManage: PermissionCheck;

  // Scrap write-offs (standard+)
  scrapCreate: PermissionCheck;
  scrapApprove: PermissionCheck;
  scrapExecute: PermissionCheck;
  scrapView: PermissionCheck;

  // Customer returns / RMA (standard+)
  returnCreate: PermissionCheck;
  returnConfirm: PermissionCheck;
  returnReceive: PermissionCheck;
  returnInspect: PermissionCheck;
  returnDispatch: PermissionCheck;
  returnView: PermissionCheck;

  // Consignment settlement (standard+)
  consignmentSettle: PermissionCheck;
  consignmentView: PermissionCheck;

  // Warehouse network config (standard+) — inter-branch resupply map
  warehouseNetworkManage: PermissionCheck;
  warehouseNetworkView: PermissionCheck;

  // UoM groups (standard+)
  uomManage: PermissionCheck;
  uomView: PermissionCheck;

  // Standard cost + variance (standard+)
  standardCostManage: PermissionCheck;
  standardCostView: PermissionCheck;
  standardCostVarianceView: PermissionCheck;

  // Landed cost (standard+)
  landedCostManage: PermissionCheck;
  landedCostApply: PermissionCheck;
  landedCostView: PermissionCheck;

  // ABC velocity classification (standard+) — nightly batch, read-only for most
  classificationRecompute: PermissionCheck;
  classificationView: PermissionCheck;

  // SKU slot assignments (standard+)
  slottingManage: PermissionCheck;
  slottingView: PermissionCheck;

  // Pick waves (standard+) — plan/release/start/complete/cancel
  waveCreate: PermissionCheck;
  waveRelease: PermissionCheck;
  waveExecute: PermissionCheck;
  waveView: PermissionCheck;

  // Labor tracking (standard+) — clock-in / clock-out / KPI
  laborClock: PermissionCheck;
  laborRecord: PermissionCheck;
  laborView: PermissionCheck;

  // LPN operations on packages (standard+) — identity stamp + seal
  lpnAssign: PermissionCheck;
  lpnSeal: PermissionCheck;
}

export const inventory: InventoryPermissions = {
  // ============================================
  // PURCHASES (Head Office Only)
  // ============================================

  /** Record stock purchases from suppliers */
  purchaseOrder: platformAdminOnly(),

  /** View purchase history */
  purchaseOrderView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Approve purchase invoices */
  purchaseApprove: platformAdminOnly(),

  /** Receive stock for purchases */
  purchaseOrderReceive: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** Record supplier payments */
  purchaseOrderPay: platformAdminOnly(),

  /** Cancel draft/approved purchases */
  purchaseOrderCancel: platformAdminOnly(),

  // ============================================
  // SUPPLIERS
  // ============================================

  /** Create/update suppliers */
  supplierManage: platformAdminOnly(),

  /** View suppliers */
  supplierView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // TRANSFERS (Challan Operations)
  // ============================================

  /** Create new stock transfer (head office only) */
  transferCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Approve transfer for dispatch */
  transferApprove: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Dispatch transfer (decrements head office stock) */
  transferDispatch: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Receive transfer at sub-branch (increments stock) */
  transferReceive: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** View transfer/challan details */
  transferView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Cancel a pending transfer */
  transferCancel: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  // ============================================
  // ADJUSTMENTS (Any Branch)
  // ============================================

  /** Adjust stock quantity (damaged, lost, recount) */
  adjust: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Bulk import/adjustment */
  bulkAdjust: platformAdminOnly(),

  // ============================================
  // VIEW OPERATIONS
  // ============================================

  /** View stock levels */
  view: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View stock across all branches */
  viewAll: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View low stock alerts */
  alerts: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View stock movement audit trail */
  movements: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View all movements across branches */
  movementsAll: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // BRANCH MANAGEMENT
  // ============================================

  /** Set head office branch */
  setHeadOffice: superadminOnly(),

  // ============================================
  // STOCK REQUESTS (Sub-branch → Head Office)
  // ============================================

  /** Create stock request from sub-branch */
  stockRequestCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View stock requests */
  stockRequestView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Approve/reject stock requests (head office only) */
  stockRequestApprove: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Fulfill stock requests (creates transfer) */
  stockRequestFulfill: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Cancel stock requests */
  stockRequestCancel: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  // ============================================
  // SUB-BRANCH TRANSFERS
  // ============================================

  /** Create sub-branch to sub-branch transfers */
  subBranchTransfer: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Return stock from sub-branch to head office */
  returnToHead: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // LOT/SERIAL TRACKING (Standard+)
  // ============================================

  /** Create/update lot/serial records */
  lotManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View lot/serial records */
  lotView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // PACKAGE MANAGEMENT (Standard+)
  // ============================================

  /** Create/nest/unnest packages */
  packageManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View packages */
  packageView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // PROCUREMENT (Standard+)
  // ============================================

  /** Create procurement orders */
  procurementCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Approve procurement orders */
  procurementApprove: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Receive procurement items */
  procurementReceive: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** View procurement orders */
  procurementView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // REPLENISHMENT RULES (Standard+)
  // ============================================

  /** Create/update/delete replenishment rules */
  replenishmentManage: platformAdminOnly(),

  /** View replenishment rules */
  replenishmentView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // COST LAYERS & VALUATION (Standard+)
  // ============================================

  /** View cost layers and inventory valuation */
  costView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // TRACEABILITY (Enterprise)
  // ============================================

  /** Trace lot/serial movement history and recall analysis */
  traceView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // REPORTS (Enterprise)
  // ============================================

  /** View inventory reports (aging, turnover, health) */
  reportView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // QUALITY INSPECTION (Enterprise)
  // ============================================

  /** View quality points and checks */
  qualityView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** Create/manage quality points, record results, apply dispositions */
  qualityManage: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  // ============================================
  // EXECUTION TASKS / SCANNER (Enterprise)
  // ============================================

  /** Create queues, generate tasks from move groups */
  taskManage: platformAdminOnly(),

  /** Execute tasks: get next, complete, report exception, sessions */
  taskExecute: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  // ============================================
  // DISPATCH / CARRIER / DOCK (Enterprise)
  // ============================================

  /** Create manifests, carriers, dock doors, appointments */
  dispatchManage: platformAdminOnly(),

  // ============================================
  // SCRAP WRITE-OFFS (Standard+)
  // ============================================

  /** Draft a new scrap (damaged / expired / shrinkage / etc.) */
  scrapCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Approve a draft scrap */
  scrapApprove: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Execute an approved scrap — posts the move, deducts stock */
  scrapExecute: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View scrap records */
  scrapView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // CUSTOMER RETURNS / RMA (Standard+)
  // ============================================

  /** Draft a new customer return */
  returnCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Confirm / authorise an RMA */
  returnConfirm: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Receive physical goods against an RMA */
  returnReceive: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** Inspect returned goods and assign dispositions */
  returnInspect: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** Dispatch per-line (restock / scrap / RTV / rework) */
  returnDispatch: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View return orders */
  returnView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // CONSIGNMENT SETTLEMENT (Standard+)
  // ============================================

  /** Trigger settlement for a specific move */
  consignmentSettle: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View consignment-stock summaries + settlement events */
  consignmentView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // WAREHOUSE NETWORK CONFIG (Standard+)
  // ============================================

  /** Edit the inter-branch resupply map */
  warehouseNetworkManage: platformAdminOnly(),

  /** View the network config */
  warehouseNetworkView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // UoM GROUPS (Standard+)
  // ============================================

  /** Create / update / delete UoM groups */
  uomManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View UoM groups */
  uomView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // STANDARD COST + VARIANCE (Standard+)
  // ============================================

  /** Publish / revise per-SKU standard costs */
  standardCostManage: platformAdminOnly(),

  /** View standard-cost history */
  standardCostView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View purchase-price variance reports */
  standardCostVarianceView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // LANDED COST (Standard+)
  // ============================================

  /** Draft / edit landed-cost documents (freight, duty, insurance) */
  landedCostManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Apply or reverse a landed-cost doc — hits cost-layer allocations */
  landedCostApply: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** View landed-cost history + allocations */
  landedCostView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // ABC VELOCITY CLASSIFICATION (Standard+)
  // ============================================

  /** Trigger recompute of ABC tiers from the stock-event ledger */
  classificationRecompute: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** View computed ABC classifications */
  classificationView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  // ============================================
  // SLOTTING (Standard+)
  // ============================================

  /** Assign / reslot / deactivate SKU → location assignments */
  slottingManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** View current and historical slot assignments */
  slottingView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // PICK WAVES (Standard+)
  // ============================================

  /** Plan / cancel a wave — supervisor role */
  waveCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Release a wave to the floor — supervisor role */
  waveRelease: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  /** Start / complete a wave — pickers on the floor */
  waveExecute: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** View waves + status */
  waveView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  // ============================================
  // LABOR TRACKING (Standard+)
  // ============================================

  /** Clock in / clock out / break transitions — the worker's own action */
  laborClock: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** Record task-level labor events (task_started / completed / exception) */
  laborRecord: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),

  /** View sessions + labor ledger + KPIs — supervisor visibility */
  laborView: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),

  // ============================================
  // LPN / CONTAINER IDENTITY (Standard+)
  // ============================================

  /** Stamp an LPN code on a package — one-time per container */
  lpnAssign: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),

  /** Seal a package (locks nesting) — pre-dispatch operation */
  lpnSeal: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.inventoryStaff)),
};

export default inventory;
