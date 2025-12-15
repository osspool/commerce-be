import { Repository } from '@classytic/mongokit';
import User from './user.model.js';

/**
 * User Repository
 * 
 * Pure data access layer for auth.
 * User model is auth-only (email, password, roles).
 */
export class UserRepository extends Repository {
  constructor(model) {
    super(model);
  }

  /**
   * Find user by email (with password for login verification)
   * @param {string} email - User email (case-insensitive)
   * @returns {Promise<Object|null>}
   */
  async findByEmail(email) {
    return this.Model.findOne({ 
      email: email.toLowerCase().trim() 
    }).select('+password');
  }

  /**
   * Find user by ID with password (for password change)
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>}
   */
  async findByIdWithPassword(userId) {
    return this.Model.findById(userId).select('+password');
  }

  /**
   * Find user by reset token
   * @param {string} token - Password reset token
   * @returns {Promise<Object|null>}
   */
  async findByResetToken(token) {
    return this.Model.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    }).select('+resetPasswordToken +resetPasswordExpires');
  }

  /**
   * Check if email exists
   * @param {string} email - User email
   * @returns {Promise<boolean>}
   */
  async emailExists(email) {
    return this.exists({ email: email.toLowerCase().trim() });
  }

  /**
   * Update user password
   * @param {string} userId - User ID
   * @param {string} newPassword - New password (will be hashed by model hook)
   * @returns {Promise<Object>}
   */
  async updatePassword(userId, newPassword) {
    const user = await this.Model.findById(userId).select('+password +resetPasswordToken +resetPasswordExpires');
    if (!user) {
      throw new Error('User not found');
    }

    user.password = newPassword; // Model hook will hash it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();
    return user;
  }

  /**
   * Set password reset token
   * @param {string} userId - User ID
   * @param {string} token - Reset token
   * @param {Date} expiresAt - Token expiration
   * @returns {Promise<Object>}
   */
  async setResetToken(userId, token, expiresAt) {
    return this.Model.findByIdAndUpdate(
      userId,
      {
        resetPasswordToken: token,
        resetPasswordExpires: expiresAt,
      },
      { new: true }
    );
  }

  /**
   * Deactivate user account
   * @param {string} userId - User ID
   * @returns {Promise<Object>}
   */
  async deactivate(userId) {
    return this.update(userId, { isActive: false });
  }

  /**
   * Reactivate user account
   * @param {string} userId - User ID
   * @returns {Promise<Object>}
   */
  async reactivate(userId) {
    return this.update(userId, { isActive: true });
  }

  /**
   * Update user roles (admin only)
   * @param {string} userId - User ID
   * @param {string[]} roles - New roles array
   * @returns {Promise<Object>}
   */
  async updateRoles(userId, roles) {
    return this.update(userId, { roles });
  }

  /**
   * Get users by role
   * @param {string} role - Role to filter by
   * @param {Object} params - Pagination params
   * @returns {Promise<Object>}
   */
  async getByRole(role, params = {}) {
    return this.getAll({
      ...params,
      filters: { roles: role, isActive: true, ...params.filters },
    });
  }

  /**
   * Get all admins
   * @param {Object} params - Pagination params
   * @returns {Promise<Object>}
   */
  async getAdmins(params = {}) {
    return this.getAll({
      ...params,
      filters: {
        roles: { $in: ['admin', 'superadmin'] },
        isActive: true,
        ...params.filters,
      },
    });
  }
}

const userRepository = new UserRepository(User);
export default userRepository;
