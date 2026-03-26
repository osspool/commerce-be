import { BaseController } from '@classytic/arc';
import userRepository from './user.repository.js';
import { userSchemaOptions } from './schemas.js';
import * as authWorkflow from './auth.workflow.js';

/**
 * User Controller
 *
 * CRUD operations (admin only) via BaseController + profile endpoints.
 * Auth operations (sign-in, sign-up, password reset) are handled by
 * Better Auth at /api/auth/* — not by this controller.
 */
export class UserController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, { schemaOptions });
  }

  /**
   * Get current user profile
   */
  async getProfile(request, reply) {
    const userId = request.user?.id || request.user?._id;
    const user = await authWorkflow.getUserProfile(userId);

    return reply.send({ success: true, data: user });
  }

  /**
   * Update current user profile
   */
  async updateProfile(request, reply) {
    const userId = request.user?.id || request.user?._id;
    const user = await authWorkflow.updateUserProfile(userId, request.body);

    return reply.send({ success: true, message: 'User updated successfully', data: user });
  }

  /**
   * Get user organizations (branches)
   */
  async getUserOrganizations(request, reply) {
    const userId = request.user?.id || request.user?._id;
    const organizations = await authWorkflow.getUserOrganizations(userId);

    return reply.send({ success: true, data: organizations });
  }
}

const userController = new UserController(userRepository, userSchemaOptions);
export default userController;
