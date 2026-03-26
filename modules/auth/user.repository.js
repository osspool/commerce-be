import { Repository } from '@classytic/mongokit';
import User from './user.model.js';

/**
 * User Repository
 *
 * Data access layer for BA-managed user collection.
 * Password management, token refresh, and auth flows are handled by Better Auth.
 * This repository provides user query and admin management operations.
 */
export class UserRepository extends Repository {
  constructor(model) {
    super(model);
  }

  /**
   * Check if email exists
   */
  async emailExists(email) {
    const count = await this.Model.countDocuments({ email: email.toLowerCase().trim() });
    return count > 0;
  }

  /**
   * Deactivate user account
   */
  async deactivate(userId) {
    return this.update(userId, { isActive: false });
  }

  /**
   * Reactivate user account
   */
  async reactivate(userId) {
    return this.update(userId, { isActive: true });
  }

  /**
   * Update user system roles (admin only)
   * Uses `role` field (string[]) — matches BA admin plugin convention.
   */
  async updateRoles(userId, role) {
    return this.update(userId, { role });
  }

  /**
   * Get users by system role
   */
  async getByRole(role, params = {}) {
    return this.getAll({
      ...params,
      filters: { role, isActive: true, ...params.filters },
    });
  }

  /**
   * Get all admin/superadmin users
   */
  async getAdmins(params = {}) {
    return this.getAll({
      ...params,
      filters: {
        role: { $in: ['admin', 'superadmin'] },
        isActive: true,
        ...params.filters,
      },
    });
  }
}

const userRepository = new UserRepository(User);
export default userRepository;
