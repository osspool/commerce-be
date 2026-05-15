/**
 * Centralized Permission Primitives — Single Source of Truth
 *
 * Single-tenant, multi-branch model (Nike → Nike US, Nike UK).
 * BA organizations = branches within the ONE company.
 *
 * Two-level role architecture:
 * - Platform roles (user.role): superadmin, admin, user
 *     → platformAdminOnly(), superadminOnly()
 * - Branch/org roles (scope.orgRoles): finance_admin, cashier, etc.
 *     → requireOrgRole(), requireOrgMembership()
 *
 * ALL permission config files (config/permissions/*.ts, resources/*.ts)
 * import these helpers from here. Do NOT duplicate them.
 */
import type { PermissionCheck } from '@classytic/arc';

// Re-export arc primitives so consumers only need one import path
export {
  allOf,
  allowPublic,
  anyOf,
  denyAll,
  requireAuth,
  requireOrgMembership,
  requireOrgRole,
  requireRoles,
} from '@classytic/arc/permissions';

import { allowPublic, requireAuth, requireOrgMembership, requireRoles } from '@classytic/arc/permissions';
import { groups } from '#config/permissions/roles.js';

// Re-export for convenience
export { groups, orgGroups, orgRoles, roles } from '#config/permissions/roles.js';

// ---------------------------------------------------------------------------
// Platform-only role checks (arc 2.7.3 hardening)
//
// arc 2.7.1+ defaults requireRoles() to includeOrgRoles:true, which means
// a user whose ONLY 'admin' role is on their branch membership (not
// user.role) would silently pass a platform admin gate.
//
// Today safe because org-role names (branch_manager, finance_admin, …)
// don't overlap platform names (admin, superadmin). These helpers enforce
// that intent as code — prevents future privilege-escalation if someone
// adds orgRoles.ADMIN = 'admin'.
//
// SINGLE SOURCE OF TRUTH — all permission configs import from here.
// ---------------------------------------------------------------------------

/** Platform admin (admin | superadmin) — checks user.role ONLY */
export const platformAdminOnly = (): PermissionCheck => requireRoles(groups.platformAdmin, { includeOrgRoles: false });

/** Superadmin only — checks user.role ONLY */
export const superadminOnly = (): PermissionCheck => requireRoles(groups.superadminOnly, { includeOrgRoles: false });

// ---------------------------------------------------------------------------
// Finance role gates (org-roles or platform-admin)
//
// Both helpers accept platform admins as a top-level escape hatch — `admin`
// is a platform role, not an org role, but finance ops legitimately require
// admin override. `requireRoles()`'s default `includeOrgRoles:true` lets the
// matcher find `finance_admin` / `finance_manager` on either the user's
// platform role array OR their active-org membership role.
//
// The two helpers represent the two distinct finance-permission tiers used
// across the accounting subsystem — do not collapse them.
// ---------------------------------------------------------------------------

/**
 * Finance admin gate: platform `admin` or org-role `finance_admin`.
 *
 * Use for mutating finance ops where the canonical reviewer is the org's
 * finance admin: posting / paying invoices and bills, journal-entry
 * post / reverse, opening-balance migrations, period-close wizard, partner
 * opening balances, Musok / VAT invoice mutations, A/R + A/P actions.
 *
 * Excludes `finance_manager` — managers approve but do not post.
 */
export const requireFinanceAdmin = (): PermissionCheck =>
  requireRoles('admin', 'finance_admin');

/**
 * Finance manager gate: platform `admin` or org-roles
 * `finance_admin` / `finance_manager`.
 *
 * Use for the broader finance-team surface — invoice / recurring-invoice /
 * payment-term CRUD + non-state-mutating finance reads (FX rate list/get)
 * where the manager role is allowed alongside the admin. Tighter mutations
 * (post / approve / reverse) should still gate on `requireFinanceAdmin()`.
 */
export const requireFinanceManager = (): PermissionCheck =>
  requireRoles('admin', 'finance_admin', 'finance_manager');

// ---------------------------------------------------------------------------
// HQ head-office gate
//
// Single-tenant, multi-branch: HQ-only routes (cross-branch sales overview,
// fiscal periods, period close, tax settings) require both a platform-admin
// role AND that the caller's active-branch (`x-organization-id` / session
// active org) is the head office. Sub-branch admins are intentionally
// rejected — they should not pull cross-branch data while operating on a
// sub-branch screen. Per AGENTS.md, branch role lives on the Branch document
// under either `role` (model field) or `branchRole` (denormalised from BA
// org metadata) — accept either.
//
// Implementation note: declared as an `async (ctx) => …` predicate (not a
// `() => PermissionCheck` factory) so each call inherits the captured
// `groups.platformAdmin` and the branch-repository import without a per-call
// closure. The arc PermissionCheck signature supports async predicates.
// ---------------------------------------------------------------------------

/**
 * HQ admin gate: platform admin AND active branch's role is `head_office`.
 *
 * Use for cross-branch reports, fiscal-period / period-close routes, exchange
 * rate writes, tax-settings, and any other consolidated dashboard endpoint
 * that should be unreachable from a sub-branch session context. The check is
 * async — it reads the branch document to resolve the role. Throws
 * `ForbiddenError` semantics via the standard `{ granted, reason }` return.
 */
export const requireHeadOfficeAdmin: PermissionCheck = async (ctx) => {
  const userRoles = Array.isArray(ctx.user?.role)
    ? (ctx.user!.role as string[])
    : ctx.user?.role
      ? [String(ctx.user.role)]
      : [];
  const isPlatformAdmin = userRoles.some((r) =>
    (groups.platformAdmin as readonly string[]).includes(r),
  );
  if (!isPlatformAdmin) {
    return { granted: false, reason: 'Head-office admin gate requires platform admin role.' };
  }

  const orgId =
    (ctx.request.headers?.['x-organization-id'] as string | undefined) ??
    (ctx.request as { scope?: { organizationId?: string } }).scope?.organizationId;
  if (!orgId) {
    return { granted: false, reason: 'Head-office admin gate requires an active branch context.' };
  }

  // Dynamic import: avoids a hard load-order coupling between this shared
  // module and the branch resource (branch.repository touches the mongoose
  // connection at module-evaluation time). The import is cached after the
  // first call so the hot path stays sync after warmup.
  const { default: branchRepository } = await import(
    '#resources/commerce/branch/branch.repository.js'
  );

  // Branch documents may store the role under `role` (model field) or
  // `branchRole` (denormalised from BA org metadata) — accept either, per
  // AGENTS.md → "Arc — patterns + gotchas".
  const branch = (await branchRepository.getById(orgId)) as
    | { role?: string; branchRole?: string }
    | null;
  const branchRole = branch?.role ?? branch?.branchRole;
  if (!branch || branchRole !== 'head_office') {
    return {
      granted: false,
      reason: 'This route is only available from the head-office branch context.',
    };
  }

  return { granted: true };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrudPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

type ResourceName = keyof typeof policies;

// ---------------------------------------------------------------------------
// Common policy patterns
// ---------------------------------------------------------------------------

/** Public list/get, platform admin create/update/delete */
const publicReadAdminWrite: CrudPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

/** All CRUD requires platform admin */
const adminAll: CrudPermissions = {
  list: platformAdminOnly(),
  get: platformAdminOnly(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

/** All CRUD requires auth (any logged-in user) */
const authAll: CrudPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: requireAuth(),
  delete: requireAuth(),
};

// ---------------------------------------------------------------------------
// Resource Policy Map
// ---------------------------------------------------------------------------

export const policies = {
  // Catalog — public read, admin write
  product: publicReadAdminWrite,
  category: publicReadAdminWrite,
  sizeGuide: publicReadAdminWrite,

  review: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },

  // Commerce
  branch: adminAll,
  coupon: adminAll,

  order: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  customer: {
    list: requireAuth(),
    get: requireAuth(),
    create: allowPublic(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },

  // Content
  cms: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  media: adminAll,

  // Platform
  user: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: superadminOnly(),
    update: superadminOnly(),
    delete: superadminOnly(),
  },

  // Finance — platform admin (transactions are company-wide)
  transaction: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: superadminOnly(),
  },

  finance: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  job: adminAll,

  logistics: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  platform: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  analytics: authAll,

  archive: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: superadminOnly(),
  },

  // Accounting — company-wide, platform admin
  account: {
    list: requireAuth(),
    get: requireAuth(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  // Branch-scoped: journal entries carry organizationId, so reads must come
  // from a request bound to a branch (member/service/elevated scope), not
  // just any logged-in shopper.
  journalEntry: {
    list: requireOrgMembership(),
    get: requireOrgMembership(),
    create: requireOrgMembership(),
    update: requireOrgMembership(),
    delete: platformAdminOnly(),
  },

  fiscalPeriod: {
    list: requireAuth(),
    get: requireAuth(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },
} as const satisfies Record<string, CrudPermissions>;

// ---------------------------------------------------------------------------
// Custom action permissions
// ---------------------------------------------------------------------------

export const analyticsActions: Record<string, PermissionCheck> = {
  // Dashboards aggregate per-branch sales/inventory data — caller must be
  // bound to a branch context, not a public shopper.
  overview: requireOrgMembership(),
};

export const platformActions: Record<string, PermissionCheck> = {
  getConfig: allowPublic(),
  updateConfig: platformAdminOnly(),
};

export const financeActions: Record<string, PermissionCheck> = {
  any: platformAdminOnly(),
};

export const archiveActions: Record<string, PermissionCheck> = {
  purge: superadminOnly(),
};

export const logisticsActions: Record<string, PermissionCheck> = {
  public: allowPublic(),
  manage: platformAdminOnly(),
  admin: platformAdminOnly(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getResourcePermissions(resource: ResourceName): CrudPermissions {
  const policy = policies[resource];
  if (!policy) throw new Error(`Unknown resource: ${resource}`);
  return policy;
}

export const canReadResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].list;
};

export const canManageResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].create;
};

export const canDeleteResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].delete;
};
