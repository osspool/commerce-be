import jwt from 'jsonwebtoken';
import config from '#config/index.js';
import { BaseController } from '@classytic/arc';
import userRepository from './user.repository.js';
import { userSchemaOptions } from './schemas.js';
import * as authWorkflow from './auth.workflow.js';
import { NotFoundError, UnauthorizedError } from '#shared/utils/errors.js';

/**
 * User Controller
 *
 * Handles all user-related operations:
 * - CRUD operations (admin only) via BaseController
 * - Profile operations (authenticated users)
 * - Auth operations (public)
 */
export class UserController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, { schemaOptions });
  }

  // ============================================
  // PROFILE HANDLERS (authenticated)
  // ============================================

  /**
   * Get current user profile (auth info)
   */
  async getProfile(request, reply) {
    const userId = request.user._id || request.user.id;
    const user = await authWorkflow.getUserProfile(userId);

    return reply.send({
      success: true,
      data: user,
    });
  }

  /**
   * Update current user profile
   */
  async updateProfile(request, reply) {
    const userId = request.user._id || request.user.id;
    const user = await authWorkflow.updateUserProfile(userId, request.body);

    return reply.send({
      success: true,
      message: 'User updated successfully',
      data: user,
    });
  }

  /**
   * Change password (requires current password)
   */
  async changePassword(request, reply) {
    const userId = request.user._id || request.user.id;
    const { currentPassword, newPassword } = request.body;

    await authWorkflow.changePassword(userId, currentPassword, newPassword);

    return reply.send({
      success: true,
      message: 'Password changed successfully',
    });
  }

  // ============================================
  // AUTH HANDLERS (public)
  // ============================================

  /**
   * Register new user
   */
  async register(request, reply) {
    const { name, email, password } = request.body;

    await authWorkflow.registerUser({ name, email, password });

    return reply.code(201).send({
      success: true,
      message: 'User registered successfully'
    });
  }

  /**
   * Login user
   */
  async login(request, reply) {
    const { email, password } = request.body;

    const result = await authWorkflow.loginUser({ email, password });

    return reply.send({
      success: true,
      ...result
    });
  }

  /**
   * Refresh access token
   */
  async refreshToken(request, reply) {
    const { token: refreshTokenValue } = request.body;

    if (!refreshTokenValue) {
      throw new UnauthorizedError('Refresh token required');
    }

    // Verify refresh token (JWT errors auto-handled by global error handler)
    const decoded = jwt.verify(refreshTokenValue, config.app.jwtRefresh);

    // Generate new tokens
    const result = await authWorkflow.refreshAccessToken(decoded.id);

    return reply.send({
      success: true,
      ...result
    });
  }

  /**
   * Request password reset
   */
  async forgotPassword(request, reply) {
    const { email } = request.body;

    await authWorkflow.requestPasswordReset(email);

    return reply.send({
      success: true,
      message: 'Password reset email sent'
    });
  }

  /**
   * Reset password with token
   */
  async resetPassword(request, reply) {
    const { token, newPassword } = request.body;

    await authWorkflow.resetPassword(token, newPassword);

    return reply.send({
      success: true,
      message: 'Password has been reset'
    });
  }

  /**
   * Get user organizations
   */
  async getUserOrganizations(request, reply) {
    const userId = request.user._id || request.user.id;

    const organizations = await authWorkflow.getUserOrganizations(userId);

    return reply.send({
      success: true,
      data: organizations
    });
  }
}

const userController = new UserController(userRepository, userSchemaOptions);
export default userController;
