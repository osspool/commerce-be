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

export type AuditOps = { create?: boolean; update?: boolean; delete?: boolean };
export type AuditPolicy = true | AuditOps;

export interface AuditConfigSection {
  audit: {
    resources: Record<string, AuditPolicy>;
  };
}

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
  'customer-invoice': true,
  'vendor-bill': true,
  budget: true,
  account: { create: true, update: true, delete: false }, // chart of accounts rarely deleted
  'fiscal-period': { update: true, delete: false }, // close/reopen is the critical op

  // ── Content ──
  page: true,
  section: true,
};

const auditConfig: AuditConfigSection = {
  audit: { resources },
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
