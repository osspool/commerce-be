import mongoose, { type HydratedDocument, Schema } from 'mongoose';

/**
 * User Model — Better Auth Overlay
 *
 * Better Auth manages the `user` collection directly (passwords, sessions, etc.).
 * This Mongoose model is a strict:false overlay for querying BA-managed users
 * with our custom fields (role, phone, isActive).
 *
 * Branch access is now managed via BA's organization + member tables.
 * Use BA's org API to check branch membership and roles.
 */

/**
 * Branch Role Constants (for reference — now mapped to BA org roles)
 */
export const BRANCH_ROLES = Object.freeze({
  MANAGER: 'branch_manager',
  INVENTORY: 'inventory_staff',
  CASHIER: 'cashier',
  RECEIVER: 'stock_receiver',
  REQUESTER: 'stock_requester',
  VIEWER: 'viewer',
} as const);

export type BranchRole = (typeof BRANCH_ROLES)[keyof typeof BRANCH_ROLES];

export const BRANCH_ROLE_KEYS: BranchRole[] = Object.values(BRANCH_ROLES);

/**
 * System-level role values
 */
export const SYSTEM_ROLES = [
  'user',
  'admin',
  'superadmin',
  'finance-manager',
  'finance-admin',
  'store-manager',
  'store-staff',
  'warehouse-staff',
  'warehouse-admin',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/**
 * IUser interface — fields managed by our overlay
 * Better Auth manages additional fields (name, email, emailVerified, image, password, etc.)
 * via strict: false
 */
export interface IUser {
  name?: string;
  email?: string;
  emailVerified?: boolean;
  image?: string;
  role: string[];
  phone?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserMethods {
  hasRole(role: string): boolean;
  isAdmin(): boolean;
  isWarehouseStaff(): boolean;
}

export type UserDocument = HydratedDocument<IUser, IUserMethods>;

const userSchema = new Schema<IUser, mongoose.Model<IUser, object, IUserMethods>, IUserMethods>(
  {
    // BA owns these fields and writes them via its own API. Declaring them
    // here (without validators that would conflict with BA) lets Mongoose
    // hydrate them on read and persist updates via `user.save()` — which
    // the profile-update workflow relies on.
    name: { type: String },
    email: { type: String },
    emailVerified: { type: Boolean },
    image: { type: String },

    // System-level roles (global permissions)
    role: {
      type: [String],
      enum: SYSTEM_ROLES as unknown as string[],
      default: ['user'],
    },

    phone: {
      type: String,
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLoginAt: Date,
  },
  {
    strict: false, // Allow BA to store its own fields (password hash, etc.)
    timestamps: false, // BA manages createdAt/updatedAt
    collection: 'user', // Same collection BA writes to
  },
);

// ============================================
// INDEXES
// ============================================
userSchema.index({ createdAt: -1, _id: -1 });
userSchema.index({ role: 1 });

// ============================================
// INSTANCE METHODS
// ============================================

/**
 * Check if user has a system-level role
 */
userSchema.methods.hasRole = function (this: UserDocument, role: string): boolean {
  return this.role?.includes(role);
};

/**
 * Check if user is admin or superadmin
 */
userSchema.methods.isAdmin = function (this: UserDocument): boolean {
  return this.hasRole('admin') || this.hasRole('superadmin');
};

/**
 * Check if user is warehouse staff (head office)
 */
userSchema.methods.isWarehouseStaff = function (this: UserDocument): boolean {
  return this.hasRole('warehouse-staff') || this.hasRole('warehouse-admin') || this.isAdmin();
};

// ============================================
// JSON TRANSFORMS
// ============================================
userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    delete ret.password;
    return ret;
  },
});

userSchema.set('toObject', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    delete ret.password;
    return ret;
  },
});

const User = mongoose.models.User || mongoose.model<IUser>('User', userSchema);
export default User;
