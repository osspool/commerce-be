import type { IControllerResponse, IRequestContext, RouteSchemaOptions } from '@classytic/arc';
import { BaseController } from '@classytic/arc';
import type { Repository } from '@classytic/mongokit';
import * as authWorkflow from './auth.workflow.js';
import { userSchemaOptions } from './schemas.js';
import type { IUser } from './user.model.js';
import userRepository from './user.repository.js';

interface UserProfileUpdate {
  name?: string;
  email?: string;
}

/**
 * User Controller
 *
 * CRUD operations (admin only) via BaseController + profile endpoints.
 * Auth operations (sign-in, sign-up, password reset) are handled by
 * Better Auth at /api/auth/* — not by this controller.
 *
 * Pass `tenantField: false` so the QueryResolver inside BaseController does
 * NOT inject `filters.organizationId = <branchId>` into list/get queries —
 * BA users belong to orgs via the `member` collection, not via a per-doc
 * column. defineResource({ tenantField: false }) handles routing-level
 * scoping but the pre-built controller needs the same flag here.
 */
export class UserController extends BaseController<IUser> {
  constructor(service: Repository<IUser>, schemaOptions?: RouteSchemaOptions) {
    super(service, { schemaOptions, resourceName: 'user', tenantField: false });
  }

  /**
   * Get current user profile (Arc pipeline — receives IRequestContext)
   */
  async getProfile(req: IRequestContext): Promise<IControllerResponse> {
    const userId = req.user?.id || (req.user as Record<string, unknown>)?._id;
    if (!userId) return { success: false, error: 'Not authenticated', status: 401 };

    const profile = await authWorkflow.getUserProfile(userId as string);
    return { success: true, data: profile };
  }

  /**
   * Update current user profile (Arc pipeline — receives IRequestContext)
   */
  async updateProfile(req: IRequestContext<UserProfileUpdate>): Promise<IControllerResponse> {
    const userId = req.user?.id || (req.user as Record<string, unknown>)?._id;
    if (!userId) return { success: false, error: 'Not authenticated', status: 401 };

    const profile = await authWorkflow.updateUserProfile(userId as string, req.body);
    return { success: true, data: profile };
  }
}

const userController = new UserController(userRepository, userSchemaOptions);
export default userController;
