import { createError } from '@fastify/error';
import mongoose, { type HydratedDocument, type Types } from 'mongoose';
import pino from 'pino';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import type { IUser } from './user.model.js';
import userRepository from './user.repository.js';

const log = pino({ name: 'auth' });
const NotFoundError = createError('NOT_FOUND', '%s', 404);

/**
 * Auth Workflows (Better Auth era)
 *
 * Better Auth handles: sign-in, sign-up, password reset/change, token refresh, OAuth.
 * This module provides supplementary business logic for user management.
 */

interface BAUser {
  id: string;
  name: string;
  email: string;
  [key: string]: unknown;
}

interface UserProfile {
  id: Types.ObjectId | string;
  name: string | undefined;
  email: string | undefined;
  role: string[];
  phone?: string;
  isActive?: boolean;
  lastLoginAt?: Date;
  createdAt?: Date;
}

interface UserProfileUpdate {
  name?: string;
  email?: string;
}

interface UserOrganization {
  id: string;
  code: string | undefined;
  name: string | undefined;
  slug: string | undefined;
  branchType: string | undefined;
  branchRole: string | undefined;
  /** Member's roles in this org (BA supports multi-role per member) */
  memberRoles: string[];
  isDefault: boolean;
  isActive: boolean;
}

/** Normalize BA member.role to string[] (BA stores as string or string[]) */
function normalizeMemberRoles(role: unknown): string[] {
  if (Array.isArray(role)) return role.map(String);
  if (typeof role === 'string')
    return role
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  return ['viewer'];
}

function isValidObjectId(id: unknown): id is string {
  return !!id && mongoose.Types.ObjectId.isValid(id as string);
}

/**
 * Auto-link a new user to Customer model.
 * Called from BA's databaseHooks.user.create.after
 */
export async function linkCustomerOnRegistration(user: BAUser): Promise<void> {
  try {
    await customerRepository.linkOrCreateForUser({
      _id: user.id,
      name: user.name,
      email: user.email,
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to link customer on registration');
  }
}

/**
 * Get user profile (auth info only)
 */
export async function getUserProfile(userId: string): Promise<UserProfile> {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const user = (await userRepository.getById(userId)) as HydratedDocument<IUser> | null;
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
export async function updateUserProfile(
  userId: string,
  updates: UserProfileUpdate,
): Promise<Pick<UserProfile, 'id' | 'name' | 'email' | 'role'>> {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const { name, email } = updates;
  const user = (await userRepository.getById(userId)) as HydratedDocument<IUser> | null;
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
export async function getUserOrganizations(userId: string): Promise<UserOrganization[]> {
  if (!isValidObjectId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }

  const db = mongoose.connection.getClient().db();

  const members = await db
    .collection('member')
    .find({
      userId: new mongoose.Types.ObjectId(userId),
    })
    .toArray();

  if (!members.length) return [];

  const orgIds = members.map((m) => m.organizationId);
  const orgs = await db
    .collection('organization')
    .find({
      _id: { $in: orgIds },
    })
    .toArray();

  return orgs.map((org) => {
    const membership = members.find((m) => m.organizationId.toString() === org._id.toString());
    return {
      id: org._id.toString(),
      code: org.code as string | undefined,
      name: org.name as string | undefined,
      slug: org.slug as string | undefined,
      branchType: org.branchType as string | undefined,
      branchRole: org.branchRole as string | undefined,
      memberRoles: normalizeMemberRoles(membership?.role),
      isDefault: (org.isDefault as boolean) || false,
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
