import * as authWorkflow from './auth.workflow.js';

/**
 * User Profile Handlers
 * 
 * Auth-only profile. For customer data (addresses, phone),
 * use the Customer API.
 */

/**
 * Get current user profile (auth info)
 */
export async function getUserByToken(request, reply) {
  try {
    const userId = request.user._id || request.user.id;
    const user = await authWorkflow.getUserProfile(userId);

    return reply.send({
      success: true,
      data: user,
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return reply.code(404).send({
        success: false,
        message: error.message,
      });
    }
    return reply.code(500).send({
      success: false,
      message: 'Failed to fetch user profile',
    });
  }
}

/**
 * Update current user profile
 * 
 * User-editable fields (auth only):
 * - name: string
 * - email: string (validated)
 * 
 * For addresses and phone, use the Customer API.
 */
export async function updateUser(request, reply) {
  try {
    const userId = request.user._id || request.user.id;
    const user = await authWorkflow.updateUserProfile(userId, request.body);

    return reply.send({
      success: true,
      message: 'User updated successfully',
      data: user,
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return reply.code(400).send({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(e => e.message),
      });
    }
    if (error.code === 11000) {
      return reply.code(400).send({
        success: false,
        message: 'Email already exists',
      });
    }
    if (error.statusCode === 404) {
      return reply.code(404).send({
        success: false,
        message: error.message,
      });
    }
    return reply.code(500).send({
      success: false,
      message: 'Failed to update user',
    });
  }
}

/**
 * Change password (requires current password)
 */
export async function changePassword(request, reply) {
  try {
    const userId = request.user._id || request.user.id;
    const { currentPassword, newPassword } = request.body;

    await authWorkflow.changePassword(userId, currentPassword, newPassword);

    return reply.send({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
    if (error.statusCode === 404) {
      return reply.code(404).send({
        success: false,
        message: error.message,
      });
    }
    return reply.code(500).send({
      success: false,
      message: 'Failed to change password',
    });
  }
}
