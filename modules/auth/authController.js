import jwt from 'jsonwebtoken';
import config from '#config/index.js';
import * as authWorkflow from './auth.workflow.js';

/**
 * Authentication Handlers
 * Clean HTTP handlers using auth workflows
 */

/**
 * Register new user
 */
export async function register(request, reply) {
  try {
    const { name, email, password } = request.body;

    await authWorkflow.registerUser({ name, email, password });

    return reply.code(201).send({
      success: true,
      message: 'User registered successfully'
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return reply.code(400).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Register error');
    return reply.code(500).send({
      success: false,
      message: 'Error registering user'
    });
  }
}

/**
 * Login user
 */
export async function login(request, reply) {
  try {
    const { email, password } = request.body;

    const result = await authWorkflow.loginUser({ email, password });

    return reply.send({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode === 401) {
      return reply.code(401).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Login error');
    return reply.code(500).send({
      success: false,
      message: 'Login failed'
    });
  }
}

/**
 * Refresh access token
 */
export async function refreshToken(request, reply) {
  try {
    const { token: refreshTokenValue } = request.body;

    if (!refreshTokenValue) {
      return reply.code(401).send({
        success: false,
        message: 'Refresh token required'
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshTokenValue, config.app.jwtRefresh);

    // Generate new tokens
    const result = await authWorkflow.refreshAccessToken(decoded.id);

    return reply.send({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return reply.code(401).send({
        success: false,
        message: 'Invalid or expired refresh token'
      });
    }
    if (error.statusCode === 401) {
      return reply.code(401).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Refresh token error');
    return reply.code(500).send({
      success: false,
      message: 'Token refresh failed'
    });
  }
}

/**
 * Request password reset
 */
export async function forgotPassword(request, reply) {
  try {
    const { email } = request.body;

    await authWorkflow.requestPasswordReset(email);

    return reply.send({
      success: true,
      message: 'Password reset email sent'
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return reply.code(404).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Forgot password error');
    return reply.code(500).send({
      success: false,
      message: 'Failed to send reset email'
    });
  }
}

/**
 * Reset password with token
 */
export async function resetPassword(request, reply) {
  try {
    const { token, newPassword } = request.body;

    await authWorkflow.resetPassword(token, newPassword);

    return reply.send({
      success: true,
      message: 'Password has been reset'
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return reply.code(400).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Reset password error');
    return reply.code(500).send({
      success: false,
      message: 'Failed to reset password'
    });
  }
}

/**
 * Get user organizations
 */
export async function getUserOrganizations(request, reply) {
  try {
    const userId = request.user._id || request.user.id;

    const organizations = await authWorkflow.getUserOrganizations(userId);

    return reply.send({
      success: true,
      data: organizations
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return reply.code(404).send({
        success: false,
        message: error.message
      });
    }
    request.log.error({ err: error }, 'Get organizations error');
    return reply.code(500).send({
      success: false,
      message: 'Error fetching organizations'
    });
  }
}

export default {
  register,
  login,
  refreshToken,
  forgotPassword,
  resetPassword,
  getUserOrganizations
};
