/**
 * Audit Policy — which resources get Arc audit trails.
 *
 * Design principle: only audit resources where "who changed what, when"
 * is not already tracked by the domain itself.
 *
 * NOT audited (and why):
 *   - transaction     → immutable payment receipt; IS the audit trail
 *   - journal-entry   → ledger enforces immutability + tracks postedBy/stateChangedAt
 *   - cart            → ephemeral, user-facing, no business review
 *   - notification    → high-volume ephemeral delivery records
 *   - media           → file uploads, no business state
 *   - review          → customer content, not business-critical
 *   - engine-backed   → Flow/Ledger/Promo/Loyalty engines handle their own audit
 *
 * Convention:
 *   - Present in map  → audited (true = all ops, object = selective)
 *   - Absent from map → not audited
 */

export type AuditOps = {
  create?: boolean;
  update?: boolean;
  delete?: boolean;
  /**
   * Retention override (days). When set, audit rows for this resource get
   * `expiresAt = timestamp + retentionDays`, overriding the global
   * `AUDIT_TTL_DAYS` default. Use for resources subject to a longer
   * regulatory floor than ops audit needs (e.g. NBR books-of-account).
   */
  retentionDays?: number;
};
export type AuditPolicy = true | AuditOps;

export interface AuditConfigSection {
  audit: {
    /**
     * Default audit-row retention in days. Resources without a per-policy
     * `retentionDays` override fall back to this. Driven by env var
     * `AUDIT_TTL_DAYS` (positive number); defaults to 90 in dev.
     */
    defaultRetentionDays: number;
    resources: Record<string, AuditPolicy>;
  };
}

/**
 * Parse `AUDIT_TTL_DAYS` once at module load. Empty / non-numeric / non-positive
 * values fall back to the 90d default — matching the behavior of
 * `register-infra-plugins.ts` before this section owned the value.
 */
function parseDefaultRetentionDays(): number {
  const FALLBACK = 90;
  const raw = Number(process.env.AUDIT_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK;
}

/**
 * BD VAT/Mushak Rule 18 + Income Tax Ordinance s.35 require
 * books-of-account retention for 5 years from end of relevant fiscal year.
 * Round to 1825 days for any resource whose audit row IS part of the
 * statutory book trail (invoices, bills, journal entries, COA changes,
 * fiscal-period close/reopen, budget approvals).
 */
const NBR_FINANCIAL_RETENTION_DAYS = 1825;

const resources: Record<string, AuditPolicy> = {
  // ── Core business objects (state transitions affect money/inventory) ──
  order: true,
  return: true,
  'purchase-order': true,
  transfer: true,
  'stock-request': true,

  // ── Master data (changes affect downstream behavior) ──
  product: true,
  category: true,
  customer: true,
  supplier: true,
  branch: true,
  coupon: true,
  partner: true,

  // ── Accounting (action-routed state transitions, not raw ledger) ──
  // Financial resources are part of NBR's 5-year books retention floor.
  'customer-invoice': { create: true, update: true, delete: true, retentionDays: NBR_FINANCIAL_RETENTION_DAYS },
  'vendor-bill': { create: true, update: true, delete: true, retentionDays: NBR_FINANCIAL_RETENTION_DAYS },
  budget: { create: true, update: true, delete: true, retentionDays: NBR_FINANCIAL_RETENTION_DAYS },
  account: { create: true, update: true, delete: false, retentionDays: NBR_FINANCIAL_RETENTION_DAYS },
  'fiscal-period': { update: true, delete: false, retentionDays: NBR_FINANCIAL_RETENTION_DAYS },

  // ── Content ──
  page: true,
  section: true,
};

const auditConfig: AuditConfigSection = {
  audit: {
    defaultRetentionDays: parseDefaultRetentionDays(),
    resources,
  },
};

export default auditConfig;

// ── Helpers ──

/**
 * Resolve the audit flag for defineResource().
 * Returns false if not in registry → no audit.
 */
export function resolveAuditFlag(resourceName: string): boolean | { operations: string[] } {
  const policy = resources[resourceName];
  if (!policy) return false;
  if (policy === true) return true;

  const ops: string[] = [];
  if (policy.create) ops.push('create');
  if (policy.update) ops.push('update');
  if (policy.delete) ops.push('delete');
  return ops.length > 0 ? { operations: ops } : false;
}

/**
 * Per-resource retention in days. Falls back to the config section's
 * `defaultRetentionDays` (driven by `AUDIT_TTL_DAYS` env) when the
 * resource has no override.
 *
 * Called from the audit-model `pre('save')` hook — every new audit row
 * is stamped with `timestamp + retentionDays(...) * 86_400_000` at insert,
 * and a single TTL index on `expiresAt` purges accordingly.
 */
export function getRetentionDays(resourceName: string): number {
  const policy = resources[resourceName];
  if (!policy || policy === true) return auditConfig.audit.defaultRetentionDays;
  return policy.retentionDays ?? auditConfig.audit.defaultRetentionDays;
}

/**
 * Snapshot of all per-resource retention overrides as `{ resource, days }`
 * pairs. Consumed by the legacy-row backfill in register-infra-plugins.ts
 * to build a Mongo `$switch` that stamps each row with the correct TTL
 * window based on its `resource` field — without round-tripping per row.
 */
export function getRetentionOverrides(): Array<{ resource: string; days: number }> {
  const out: Array<{ resource: string; days: number }> = [];
  for (const [resource, policy] of Object.entries(resources)) {
    if (policy && policy !== true && typeof policy.retentionDays === 'number') {
      out.push({ resource, days: policy.retentionDays });
    }
  }
  return out;
}
