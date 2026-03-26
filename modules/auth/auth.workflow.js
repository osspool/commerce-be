import { createError } from '@fastify/error';
import mongoose from 'mongoose';
import userRepository from './user.repository.js';
import customerRepository from '#modules/sales/customers/customer.repository.js';

const NotFoundError = createError('NOT_FOUND', '%s', 404);

/**
 * Auth Workflows (Better Auth era)
 *
 * Better Auth handles: sign-in, sign-up, password reset/change, token refresh, OAuth.
 * This module provides supplementary business logic for user management.
 */

function isValidObjectId(id) {
  return id && mongoose.Types.ObjectId.isValid(id);
}

/**
 * Auto-link a new user to Customer model.
 * Called from BA's databaseHooks.user.create.after
 */
export async function linkCustomerOnRegistration(user) {
  try {
    await customerRepository.linkOrCreateForUser({
      _id: user.id,
      name: user.name,
      email: user.email,
    });
  } catch (error) {
    console.error('[auth] Failed to link customer on registration:', error.message);
  }
}

/**
 * Get user profile (auth info only)
 */
export async function getUserProfile(userId) {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const user = await userRepository.getById(userId);
  if (!user) throw new NotFoundError('User not found');

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * Update user profile (auth fields only)
 */
export async function updateUserProfile(userId, updates) {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const { name, email } = updates;
  const user = await userRepository.getById(userId);
  if (!user) throw new NotFoundError('User not found');

  if (name !== undefined) user.name = name;
  if (email !== undefined) {
    const normalizedEmail = email.toLowerCase().trim();
    if (normalizedEmail !== user.email) {
      const taken = await userRepository.emailExists(normalizedEmail);
      if (taken) {
        const EmailTakenError = createError('EMAIL_TAKEN', '%s', 409);
        throw new EmailTakenError('Email already in use');
      }
      user.email = normalizedEmail;
    }
  }

  await user.save();

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

/**
 * Get user organizations (branches) — reads from BA organization + member collections.
 */
export async function getUserOrganizations(userId) {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const db = mongoose.connection.getClient().db();

  const members = await db.collection('member').find({
    userId: new mongoose.Types.ObjectId(userId),
  }).toArray();

  if (!members.length) return [];

  const orgIds = members.map(m => m.organizationId);
  const orgs = await db.collection('organization').find({
    _id: { $in: orgIds },
  }).toArray();

  return orgs.map(org => {
    const membership = members.find(m => m.organizationId.toString() === org._id.toString());
    return {
      id: org._id.toString(),
      code: org.code,
      name: org.name,
      slug: org.slug,
      branchType: org.branchType,
      branchRole: org.branchRole,
      memberRole: membership?.role || 'viewer',
      isDefault: org.isDefault || false,
      isActive: org.isActive !== false,
    };
  });
}

export default {
  linkCustomerOnRegistration,
  getUserProfile,
  updateUserProfile,
  getUserOrganizations,
};
