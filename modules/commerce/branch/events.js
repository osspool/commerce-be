/**
 * Branch Module Events
 *
 * Events for branch/location management.
 * Critical for inventory systems that depend on branch-level stock.
 */

export const events = {
  'branch:created': {
    module: 'commerce/branch',
    description: 'Emitted when a new branch/location is created',
    schema: {
      type: 'object',
      required: ['branchId', 'name', 'code'],
      properties: {
        branchId: { type: 'string' },
        name: { type: 'string' },
        code: { type: 'string', description: 'Unique branch code' },
        isDefault: { type: 'boolean' },
        isActive: { type: 'boolean' },
      }
    }
  },

  'branch:updated': {
    module: 'commerce/branch',
    description: 'Emitted when branch details are updated',
    schema: {
      type: 'object',
      required: ['branchId'],
      properties: {
        branchId: { type: 'string' },
        changes: { type: 'object', description: 'Changed fields' },
      }
    }
  },

  'branch:deleted': {
    module: 'commerce/branch',
    description: 'Emitted when a branch is deleted',
    schema: {
      type: 'object',
      required: ['branchId', 'code'],
      properties: {
        branchId: { type: 'string' },
        code: { type: 'string' },
        name: { type: 'string' },
      }
    }
  },

  'branch:default-changed': {
    module: 'commerce/branch',
    description: 'Emitted when default branch is changed',
    schema: {
      type: 'object',
      required: ['newDefaultBranchId', 'oldDefaultBranchId'],
      properties: {
        newDefaultBranchId: { type: 'string' },
        oldDefaultBranchId: { type: 'string' },
        changedBy: { type: 'string', description: 'Admin user ID' },
      }
    }
  },
};

export const handlers = {
  // Events this module subscribes to
  // (Branch is typically a foundational module with no external dependencies)
};
