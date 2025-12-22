import crypto from 'crypto';
import { createError } from '@fastify/error';
import userRepository from './user.repository.js';
import customerRepository from '#modules/customer/customer.repository.js';
import { generateTokens } from '#utils/generateToken.js';
import { sendEmail } from '#utils/email.js';

const ValidationError = createError('VALIDATION_ERROR', '%s', 400);
const UnauthorizedError = createError('UNAUTHORIZED', '%s', 401);
const NotFoundError = createError('NOT_FOUND', '%s', 404);

/**
 * Auth Workflows
 * 
 * Business logic for authentication.
 * User model is auth-only (email, password, roles).
 * Profile data (addresses, phone) lives in Customer model.
 * 
 * On registration: Auto-links to existing Customer (by email) or creates new one.
 */

/**
 * Register new user
 * Auto-links to existing Customer if email matches (e.g., from guest checkout)
 * 
 * @param {Object} data - User registration data
 * @param {string} data.name - User name
 * @param {string} data.email - User email
 * @param {string} data.password - User password
 * @param {string} [data.phone] - User phone (optional, format: 01XXXXXXXXX)
 * @returns {Promise<Object>} Created user with linked customer
 */
export async function registerUser({ name, email, password, phone }) {
  // Check if user already exists
  const exists = await userRepository.emailExists(email);
  if (exists) {
    throw new ValidationError('User already exists');
  }

  // Create user (password will be hashed by model hook)
  const user = await userRepository.create({
    name,
    email: email.toLowerCase().trim(),
    password,
    phone: phone?.trim() || undefined,
    roles: ['user'],
  });

  // Auto-link or create customer profile
  // This links to existing customer (from guest checkout) or creates new one
  try {
    await customerRepository.linkOrCreateForUser(user);
  } catch (error) {
    // Log but don't fail registration if customer linking fails
    console.error('Failed to link customer on registration:', error.message);
  }

  return user;
}

/**
 * Login user
 * @param {Object} credentials - Login credentials
 * @param {string} credentials.email - User email
 * @param {string} credentials.password - User password
 * @returns {Promise<Object>} { token, refreshToken, user }
 */
export async function loginUser({ email, password }) {
  // Find user by email (include password for verification)
  const user = await userRepository.findByEmail(email);

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Check if account is active
  if (user.isActive === false) {
    throw new UnauthorizedError('Account is disabled');
  }

  // Verify password (using model method)
  const isValid = await user.matchPassword(password);
  if (!isValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Update last login
  user.lastLoginAt = new Date();
  await user.save();

  // Generate tokens
  const { token, refreshToken } = generateTokens(user);

  // Get primary branch
  const primaryBranch = user.getPrimaryBranch?.();
  const branchData = primaryBranch ? {
    branchId: primaryBranch.branchId?.toString?.() || primaryBranch.branchId,
    branchCode: primaryBranch.branchCode,
    branchName: primaryBranch.branchName,
    branchRole: primaryBranch.branchRole,
    roles: primaryBranch.roles || [],
  } : null;

  // Map branches array with consistent structure for dashboard/branch switching
  const branches = (user.branches || []).map(b => ({
    branchId: b.branchId?.toString?.() || b.branchId,
    branchCode: b.branchCode,
    branchName: b.branchName,
    branchRole: b.branchRole,
    roles: b.roles || [],
    isPrimary: b.isPrimary || false,
  }));

  // Build user response
  const userData = {
    id: user._id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    // Branch info
    branch: branchData,             // Primary/active branch
    branches,                       // All assigned branches with roles
    branchIds: user.getBranchIds?.() || [],
    // Employee flags
    isAdmin: user.isAdmin?.() || false,
    isWarehouseStaff: user.isWarehouseStaff?.() || false,
  };

  return { token, refreshToken, user: userData };
}

/**
 * Refresh access token
 * @param {string} userId - User ID from decoded refresh token
 * @returns {Promise<Object>} { token, refreshToken }
 */
export async function refreshAccessToken(userId) {
  const user = await userRepository.getById(userId);

  if (!user) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  if (user.isActive === false) {
    throw new UnauthorizedError('Account is disabled');
  }

  const { token, refreshToken } = generateTokens(user);

  return { token, refreshToken };
}

/**
 * Request password reset
 * @param {string} email - User email
 * @returns {Promise<void>}
 */
export async function requestPasswordReset(email) {
  const user = await userRepository.findByEmail(email);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Generate reset token
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 3600000); // 1 hour

  // Save token to user
  await userRepository.setResetToken(user._id, token, expiresAt);

  // Send reset email
  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

  const htmlTemplate = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset. Click the link below to reset your password:</p>
    <p><a href="${resetLink}">Reset Password</a></p>
    <p>This link will expire in 1 hour.</p>
    <p>If you didn't request this, please ignore this email.</p>
    <p>Thank you!</p>
  `;

  const textVersion = `
    Password Reset Request

    You requested a password reset. Click the following link to reset your password:
    ${resetLink}

    This link will expire in 1 hour.

    If you didn't request this, please ignore this email.

    Thank you!
  `;

  await sendEmail({
    to: email,
    subject: 'Password Reset Request',
    text: textVersion,
    html: htmlTemplate,
  });
}

/**
 * Reset password with token
 * @param {string} token - Password reset token
 * @param {string} newPassword - New password
 * @returns {Promise<void>}
 */
export async function resetPassword(token, newPassword) {
  const user = await userRepository.findByResetToken(token);

  if (!user) {
    throw new ValidationError('Invalid or expired token');
  }

  // Update password (model hook will hash it)
  await userRepository.updatePassword(user._id, newPassword);
}

/**
 * Get user profile (auth info only)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} User profile
 */
export async function getUserProfile(userId) {
  const user = await userRepository.getById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * Update user profile (auth fields only)
 * @param {string} userId - User ID
 * @param {Object} updates - Profile updates (name, email only)
 * @returns {Promise<Object>} Updated user
 */
export async function updateUserProfile(userId, updates) {
  const { name, email } = updates;

  const user = await userRepository.getById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Only allow updating name and email
  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email.toLowerCase().trim();

  await user.save();

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    roles: user.roles,
  };
}

/**
 * Change password (requires current password)
 * @param {string} userId - User ID
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 */
export async function changePassword(userId, currentPassword, newPassword) {
  const user = await userRepository.findByIdWithPassword(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Verify current password
  const isValid = await user.matchPassword(currentPassword);
  if (!isValid) {
    throw new ValidationError('Current password is incorrect');
  }

  // Update password
  await userRepository.updatePassword(userId, newPassword);
}

export default {
  registerUser,
  loginUser,
  refreshAccessToken,
  requestPasswordReset,
  resetPassword,
  getUserProfile,
  updateUserProfile,
  changePassword,
};
