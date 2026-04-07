/**
 * Notification Recipient Resolution
 *
 * Reads recipient roles from notification.triggers.ts (single source of truth).
 * Resolves concrete user IDs by querying Better Auth's member collection.
 */

import mongoose from 'mongoose';
import { NOTIFICATION_TRIGGERS } from './notification.triggers.js';

interface ResolvedRecipient {
  userId: string;
  email?: string;
  name?: string;
}

/**
 * Resolve recipients for a notification type within a branch.
 *
 * Looks up the target roles from the trigger registry, then queries
 * Better Auth's member collection to find matching users.
 */
export async function resolveRecipients(
  type: string,
  organizationId: string,
  excludeUserId?: string,
): Promise<ResolvedRecipient[]> {
  const trigger = NOTIFICATION_TRIGGERS.find((t) => (t.type || t.event) === type);
  if (!trigger) return [];

  const roles = trigger.recipients;
  if (roles.length === 0) return [];

  const db = mongoose.connection.db;
  if (!db) return [];

  // Query Better Auth's member collection
  const memberFilter: Record<string, unknown> = { organizationId };
  if (!roles.includes('*')) {
    // BA stores role as a string (single role) or comma-separated string
    memberFilter.$or = roles.map((role) => ({
      role: { $regex: role, $options: 'i' },
    }));
  }

  const members = await db.collection('member').find(memberFilter).toArray();
  if (members.length === 0) return [];

  // Deduplicate by userId and exclude the triggering user
  const userIdSet = new Set<string>();
  for (const m of members) {
    const uid = String(m.userId);
    if (uid !== excludeUserId) userIdSet.add(uid);
  }

  if (userIdSet.size === 0) return [];

  // Look up user details
  const userIds = [...userIdSet];
  const users = await db
    .collection('user')
    .find({ id: { $in: userIds } })
    .project({ id: 1, email: 1, name: 1 })
    .toArray();

  const userMap = new Map(users.map((u) => [String(u.id), u]));

  return userIds.map((uid) => {
    const user = userMap.get(uid);
    return {
      userId: uid,
      email: user?.email as string | undefined,
      name: user?.name as string | undefined,
    };
  });
}
