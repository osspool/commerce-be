import { BaseController, type RequestWithExtras } from '@classytic/arc';
import type { Repository } from '@classytic/mongokit';
import type { FastifyReply } from 'fastify';
import userRepository from './user.repository.js';
import { userSchemaOptions } from './schemas.js';
import * as authWorkflow from './auth.workflow.js';
import type { IUser } from './user.model.js';

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
 */
export class UserController extends BaseController<IUser> {
  constructor(service: Repository<IUser>, schemaOptions: Record<string, unknown>) {
    super(service, { schemaOptions });
  }

  /**
   * Get current user profile
   */
  async getProfile(request: RequestWithExtras, reply: FastifyReply): Promise<void> {
    const userId = request.user?.id || request.user?._id;
    const profile = await authWorkflow.getUserProfile(userId as string);

    return reply.send({ success: true, data: profile });
  }

  /**
   * Update current user profile
   */
  async updateProfile(request: RequestWithExtras, reply: FastifyReply): Promise<void> {
    const userId = request.user?.id || request.user?._id;
    const body = request.body as UserProfileUpdate;
    const profile = await authWorkflow.updateUserProfile(userId as string, body);

    return reply.send({ success: true, message: 'User updated successfully', data: profile });
  }

  /**
   * Get user organizations (branches)
   */
  async getUserOrganizations(request: RequestWithExtras, reply: FastifyReply): Promise<void> {
    const userId = request.user?.id || request.user?._id;
    const organizations = await authWorkflow.getUserOrganizations(userId as string);

    return reply.send({ success: true, data: organizations });
  }
}

const userController = new UserController(userRepository, userSchemaOptions as unknown as Record<string, unknown>);
export default userController;
