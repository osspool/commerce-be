import { Repository } from '@classytic/mongokit';
import type { IUser } from './user.model.js';
import User from './user.model.js';

/**
 * User Repository
 *
 * Data access layer for BA-managed user collection.
 * Password management, token refresh, and auth flows are handled by Better Auth.
 * This repository provides user query and admin management operations.
 */

interface GetAllParams {
  filters?: Record<string, unknown>;
  [key: string]: unknown;
}

type GetAllResult = ReturnType<Repository<IUser>['getAll']>;
type UpdateResult = ReturnType<Repository<IUser>['update']>;

export class UserRepository extends Repository<IUser> {
  /**
   * Check if email exists
   */
  async emailExists(email: string): Promise<boolean> {
    const count = await this.Model.countDocuments({ email: email.toLowerCase().trim() });
    return count > 0;
  }

  /**
   * Deactivate user account
   */
  async deactivate(userId: string): UpdateResult {
    return this.update(userId, { isActive: false });
  }

  /**
   * Reactivate user account
   */
  async reactivate(userId: string): UpdateResult {
    return this.update(userId, { isActive: true });
  }

  /**
   * Update user system roles (admin only)
   * Uses `role` field (string[]) — matches BA admin plugin convention.
   */
  async updateRoles(userId: string, role: string[]): UpdateResult {
    return this.update(userId, { role });
  }

  /**
   * Get users by system role
   */
  async getByRole(role: string, params: GetAllParams = {}): GetAllResult {
    return this.getAll({
      ...params,
      filters: { role, isActive: true, ...params.filters },
    });
  }

  /**
   * Get all admin/superadmin users
   */
  async getAdmins(params: GetAllParams = {}): GetAllResult {
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
