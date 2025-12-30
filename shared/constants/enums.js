// Central enums file - Only shared/common enums
// Module-specific enums live in their respective modules (e.g., #modules/course/course.enums.js)



// Shared Background Job status enums (common across modules)
export const STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
export const STATUS_VALUES = Object.values(STATUS);

// Job enums (common)
// Note: Module-specific job types are defined in their respective *.jobs.js files
// e.g., POS_JOB_TYPES in #modules/sales/pos/pos.jobs.js
export const JOB_TYPES = {
  // System jobs
  STALE_SESSION_CLEANUP: 'stale-session-cleanup',
  // Inventory jobs (legacy - use INVENTORY_JOB_TYPES from inventory.jobs.js)
  STOCK_ALERT: 'STOCK_ALERT',
  INVENTORY_CONSISTENCY_CHECK: 'INVENTORY_CONSISTENCY_CHECK',
  // POS jobs (legacy - use POS_JOB_TYPES from pos.jobs.js)
  POS_CREATE_TRANSACTION: 'POS_CREATE_TRANSACTION',
};
export const JOB_TYPE_VALUES = [
  // Export jobs
  'ORDER_EXPORT',
  'PRODUCT_EXPORT',
  // Inventory jobs
  'INVENTORY_SYNC',
  'STOCK_ALERT',
  'INVENTORY_CONSISTENCY_CHECK',
  // System jobs
  'STALE_SESSION_CLEANUP',
  // POS jobs
  'POS_CREATE_TRANSACTION',
  // Test jobs
  'TEST_JOB',
  'ZOMBIE_JOB',
];


// Legacy CONSTANTS export for backward compatibility
export const CONSTANTS = {
  STATUS,
  STATUS_VALUES,
  JOB_TYPES,
  JOB_TYPE_VALUES,
};

export default CONSTANTS;
