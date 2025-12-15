import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * User Model - Authentication Only
 * 
 * Single responsibility: Handle auth (login, password, roles)
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
    password: { 
      type: String, 
      required: true,
      select: false,
    },

    roles: {
      type: [String],
      enum: ['user', 'admin', 'superadmin', 'finance-manager', 'store-manager'],
      default: ['user'],
    },

    // Branch assignment for store managers (embedded to avoid lookups)
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

// Minimal indexes - email unique is in schema, just need pagination
userSchema.index({ createdAt: -1, _id: -1 });
userSchema.index({ 'branch.branchId': 1 }, { sparse: true });

// Password hashing
userSchema.pre('save', async function() {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
});

userSchema.methods.matchPassword = async function(enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.hasRole = function(role) {
  return this.roles?.includes(role);
};

userSchema.methods.isAdmin = function() {
  return this.hasRole('admin') || this.hasRole('superadmin');
};

userSchema.methods.canManageBranch = function(branchId) {
  // Admins can manage all branches
  if (this.isAdmin()) return true;
  // Store managers can only manage their assigned branch
  if (this.hasRole('store-manager') && this.branch?.branchId) {
    return this.branch.branchId.toString() === branchId.toString();
  }
  return false;
};

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

userSchema.set('toObject', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

export default mongoose.model('User', userSchema);
