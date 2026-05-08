/**
 * Approval Plugin
 *
 * Registers the approval resource (auto-discovered too — this plugin's
 * primary job is wiring the Better-Auth-aware `RoleResolver` so policies
 * with `roles: [...]` step templates can expand into concrete user IDs at
 * submit time.
 *
 * Why a plugin and not a top-level call:
 *   - `setRoleResolver()` must run AFTER the DB is connected, since the
 *     resolver queries Better Auth's `member` + `user` collections via
 *     `mongoose.connection.db`.
 *   - The plugin is registered from `registerDomainBootstrap`, which runs
 *     post-connect (see `app.ts`). Top-level resolver registration would
 *     fire at module-eval time — before mongoose connects under tsx.
 *
 * Pattern modelled on
 * [resources/notifications/notification.recipients.ts](../notifications/notification.recipients.ts)
 * which already does the same `member` → `user` join for role-targeted
 * notifications.
 */

import type { FastifyPluginAsync } from 'fastify';
import mongoose from 'mongoose';
import { setRoleResolver } from './policy-resolver.js';
import type { RoleResolver } from '#core/approval/types.js';

/**
 * Platform-role names live in `user.role[]` (per
 * `config/permissions/roles.ts`) and authorise company-wide ops. Org-role
 * names live in `member.role` and authorise branch-scoped ops. The matrix
 * resolver expands BOTH so a policy can reference either tier — e.g.
 * `roles: ['superadmin']` for top-tier escalation, or `roles: ['cfo']` for
 * a custom org role you've added.
 */
const PLATFORM_ROLES = new Set(['superadmin', 'admin']);

const betterAuthRoleResolver: RoleResolver = async ({ role, branchId }) => {
  const db = mongoose.connection.db;
  if (!db) return [];

  const userIds = new Set<string>();

  // Tier 1 — platform roles in `user.role[]` (company-wide). Looked up first
  // so the role string `superadmin` / `admin` doesn't accidentally match an
  // unrelated org-role substring via the regex below.
  if (PLATFORM_ROLES.has(role.toLowerCase())) {
    const platformUsers = await db
      .collection('user')
      .find({ role: { $regex: role, $options: 'i' } })
      .project({ id: 1, _id: 1 })
      .toArray();
    for (const u of platformUsers) {
      userIds.add(String(u.id ?? u._id));
    }
  }

  // Tier 2 — org-role lookup against the requesting branch. Better Auth
  // stores `role` as a string (single role) or comma-separated. Match with a
  // case-insensitive regex so `finance_admin` finds members whose role
  // string contains it (e.g. "finance_admin" or "finance_admin,foo").
  const members = await db
    .collection('member')
    .find({
      organizationId: new mongoose.Types.ObjectId(branchId),
      role: { $regex: role, $options: 'i' },
      $or: [{ status: 'active' }, { status: { $exists: false } }],
    })
    .project({ userId: 1 })
    .toArray();
  for (const m of members) {
    userIds.add(String(m.userId));
  }

  if (userIds.size === 0) return [];

  const ids = [...userIds];
  const users = await db
    .collection('user')
    .find({ id: { $in: ids } })
    .project({ id: 1, name: 1, email: 1 })
    .toArray();

  const byId = new Map(users.map((u) => [String(u.id), u]));
  return ids.map((id) => {
    const u = byId.get(id);
    const name = (u?.name as string | undefined) ?? (u?.email as string | undefined);
    return name ? { id, name } : { id };
  });
};

const approvalPlugin: FastifyPluginAsync = async (fastify) => {
  setRoleResolver(betterAuthRoleResolver);
  fastify.log.info('approval: role resolver wired (better-auth members)');
};

export default approvalPlugin;
