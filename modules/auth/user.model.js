import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Branch Role Constants
 * Defines what a user can do within a specific branch
 */
export const BRANCH_ROLES = Object.freeze({
  MANAGER: 'branch_manager',           // Full branch control
  INVENTORY: 'inventory_staff',        // Stock operations (receive, adjust, request)
  CASHIER: 'cashier',                  // POS operations only
  RECEIVER: 'stock_receiver',          // Receive transfers only
  REQUESTER: 'stock_requester',        // Can request stock from head office
  VIEWER: 'viewer',                    // Read-only access
});

export const BRANCH_ROLE_KEYS = Object.values(BRANCH_ROLES);

/**
 * User Branch Assignment Schema
 * Embedded document for branch-specific access and roles
 *
 * Denormalized for performance - branch details cached here
 * Sync via Arc events when branch is updated
 */
const userBranchSchema = new Schema({
  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  // Denormalized fields (synced via events)
  branchCode: {
    type: String,
    trim: true,
    uppercase: true,
  },
  branchName: {
    type: String,
    trim: true,
  },
  branchRole: {
    type: String,
    enum: ['head_office', 'sub_branch'],
  },
  // Branch-specific roles (what can user do at this branch)
  roles: {
    type: [String],
    enum: BRANCH_ROLE_KEYS,
    default: [],
  },
  // Is this the user's primary/default branch?
  isPrimary: {
    type: Boolean,
    default: false,
  },
  assignedAt: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

/**
 * User Model - Authentication & Authorization
 *
 * Responsibilities:
 * - Authentication (login, password, tokens)
 * - System-level roles (admin, superadmin, etc.)
 * - Multi-branch assignments with branch-specific roles
 *
 * Design Principles:
 * - Denormalized branch data for O(1) lookups
 * - Event-driven sync when branches change
 * - Backward compatible with legacy single-branch field
 *
 * Profile data lives in Customer model (linked via Customer.userId)
 */
const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      validate: {
        validator: (v) => /^\S+@\S+\.\S+$/.test(v),
        message: (props) => `${props.value} is not a valid email!`,
      },
    },
    phone: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },

    // System-level roles (global permissions)
    roles: {
      type: [String],
      enum: [
        'user',
        'admin',
        'superadmin',
        'finance-manager',
        'finance-admin',
        'store-manager',
        'store-staff',
        'warehouse-staff',
        'warehouse-admin',
      ],
      default: ['user'],
    },

    // Multi-branch assignments (embedded for fast lookups)
    branches: {
      type: [userBranchSchema],
      default: [],
    },

    // Legacy: single branch (backward compatible, prefer branches array)
    branch: {
      branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
      branchCode: { type: String, trim: true, uppercase: true },
      branchName: { type: String, trim: true },
    },

    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },

    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

// ============================================
// INDEXES
// ============================================
userSchema.index({ createdAt: -1, _id: -1 });
userSchema.index({ 'branch.branchId': 1 }, { sparse: true });
userSchema.index({ 'branches.branchId': 1 }, { sparse: true });
userSchema.index({ roles: 1 });

// ============================================
// MIDDLEWARE
// ============================================

// Password hashing
userSchema.pre('save', async function() {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
});

// ============================================
// INSTANCE METHODS
// ============================================

userSchema.methods.matchPassword = async function(enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

/**
 * Check if user has a system-level role
 */
userSchema.methods.hasRole = function(role) {
  return this.roles?.includes(role);
};

/**
 * Check if user is admin or superadmin
 */
userSchema.methods.isAdmin = function() {
  return this.hasRole('admin') || this.hasRole('superadmin');
};

/**
 * Check if user is warehouse staff (head office)
 */
userSchema.methods.isWarehouseStaff = function() {
  return this.hasRole('warehouse-staff') || this.hasRole('warehouse-admin') || this.isAdmin();
};

/**
 * Get all branch IDs user has access to
 */
userSchema.methods.getBranchIds = function() {
  const ids = new Set();

  // From branches array
  for (const b of this.branches || []) {
    if (b.branchId) ids.add(b.branchId.toString());
  }

  // From legacy branch field
  if (this.branch?.branchId) {
    ids.add(this.branch.branchId.toString());
  }

  return [...ids];
};

/**
 * Check if user has access to a specific branch
 */
userSchema.methods.hasBranchAccess = function(branchId) {
  if (!branchId) return false;
  const targetId = branchId.toString();

  // Admins have access to all branches
  if (this.isAdmin()) return true;

  // Check branches array
  const inBranches = (this.branches || []).some(
    b => b.branchId?.toString() === targetId
  );
  if (inBranches) return true;

  // Check legacy branch
  if (this.branch?.branchId?.toString() === targetId) return true;

  return false;
};

/**
 * Check if user has a specific role at a branch
 */
userSchema.methods.hasBranchRole = function(branchId, role) {
  if (!branchId) return false;
  const targetId = branchId.toString();

  // Admins have all roles
  if (this.isAdmin()) return true;

  const assignment = (this.branches || []).find(
    b => b.branchId?.toString() === targetId
  );

  return assignment?.roles?.includes(role) || false;
};

/**
 * Get user's roles at a specific branch
 */
userSchema.methods.getBranchRoles = function(branchId) {
  if (!branchId) return [];
  const targetId = branchId.toString();

  // Admins have all roles
  if (this.isAdmin()) return BRANCH_ROLE_KEYS;

  const assignment = (this.branches || []).find(
    b => b.branchId?.toString() === targetId
  );

  return assignment?.roles || [];
};

/**
 * Get user's primary branch
 */
userSchema.methods.getPrimaryBranch = function() {
  // Check branches array for primary
  const primary = (this.branches || []).find(b => b.isPrimary);
  if (primary) return primary;

  // First branch as fallback
  if (this.branches?.length > 0) return this.branches[0];

  // Legacy branch
  if (this.branch?.branchId) return this.branch;

  return null;
};

/**
 * Check if user can manage a branch (full control)
 */
userSchema.methods.canManageBranch = function(branchId) {
  if (this.isAdmin()) return true;

  if (this.hasBranchRole(branchId, BRANCH_ROLES.MANAGER)) return true;

  // Legacy: store-manager with matching branch
  if (this.hasRole('store-manager') && this.branch?.branchId) {
    return this.branch.branchId.toString() === branchId.toString();
  }

  return false;
};

/**
 * Check if user can receive stock at a branch
 */
userSchema.methods.canReceiveStock = function(branchId) {
  if (this.isAdmin()) return true;

  return this.hasBranchRole(branchId, BRANCH_ROLES.MANAGER) ||
         this.hasBranchRole(branchId, BRANCH_ROLES.INVENTORY) ||
         this.hasBranchRole(branchId, BRANCH_ROLES.RECEIVER);
};

/**
 * Check if user can request stock from head office
 */
userSchema.methods.canRequestStock = function(branchId) {
  if (this.isAdmin()) return true;

  return this.hasBranchRole(branchId, BRANCH_ROLES.MANAGER) ||
         this.hasBranchRole(branchId, BRANCH_ROLES.INVENTORY) ||
         this.hasBranchRole(branchId, BRANCH_ROLES.REQUESTER);
};

/**
 * Check if user can adjust stock at a branch
 */
userSchema.methods.canAdjustStock = function(branchId) {
  if (this.isAdmin()) return true;

  return this.hasBranchRole(branchId, BRANCH_ROLES.MANAGER) ||
         this.hasBranchRole(branchId, BRANCH_ROLES.INVENTORY);
};

// ============================================
// STATIC METHODS
// ============================================

/**
 * Find users by branch access
 */
userSchema.statics.findByBranch = function(branchId) {
  return this.find({
    $or: [
      { 'branches.branchId': branchId },
      { 'branch.branchId': branchId },
    ],
    isActive: true,
  });
};

/**
 * Update branch details for all users (sync after branch update)
 */
userSchema.statics.syncBranchDetails = async function(branchId, updates) {
  const { code, name, role } = updates;
  const setFields = {};

  if (code !== undefined) setFields['branches.$[elem].branchCode'] = code;
  if (name !== undefined) setFields['branches.$[elem].branchName'] = name;
  if (role !== undefined) setFields['branches.$[elem].branchRole'] = role;

  if (Object.keys(setFields).length === 0) return { modifiedCount: 0 };

  const result = await this.updateMany(
    { 'branches.branchId': branchId },
    { $set: setFields },
    { arrayFilters: [{ 'elem.branchId': branchId }] }
  );

  // Also update legacy branch field
  const legacySet = {};
  if (code !== undefined) legacySet['branch.branchCode'] = code;
  if (name !== undefined) legacySet['branch.branchName'] = name;

  if (Object.keys(legacySet).length > 0) {
    await this.updateMany(
      { 'branch.branchId': branchId },
      { $set: legacySet }
    );
  }

  return result;
};

// ============================================
// JSON TRANSFORMS
// ============================================
userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

userSchema.set('toObject', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
export default User;
