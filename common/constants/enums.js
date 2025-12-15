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
export const JOB_TYPES = {
  STALE_SESSION_CLEANUP: 'stale-session-cleanup',
};
export const JOB_TYPE_VALUES = Object.values(JOB_TYPES);


// Legacy CONSTANTS export for backward compatibility
export const CONSTANTS = {
  STATUS,
  STATUS_VALUES,
  JOB_TYPES,
  JOB_TYPE_VALUES,
};

export default CONSTANTS;
