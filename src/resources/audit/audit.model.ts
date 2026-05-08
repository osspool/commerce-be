/**
 * Mongoose schema + model for `audit_logs`.
 *
 * Loose schema (`strict: false`) for WRITES — Arc's audit plugin owns
 * the document shape (before / after / changes / metadata / …) and we
 * pass it through unchanged. But the project sets `strictQuery: true`
 * globally (see `src/config/db.connect.ts`), so QUERY filters against
 * fields not declared in the schema get stripped before reaching
 * mongo. Therefore we DO declare the fields the SDK + audit-resource
 * queries against — `resource`, `documentId`, `action`, `userId`,
 * `organizationId`, `timestamp` — even though their write-side shape
 * is owned by Arc.
 *
 * The two fields we control end-to-end:
 *
 *   `_id`       — string. Arc's repository-audit-adapter writes
 *                 `entry.id` (e.g. "aud_kx9w2_a4b7c1d2", produced by
 *                 stores/interface.ts#generateAuditId) into the kit's
 *                 `idField` (resolves to `_id` on mongokit). Without
 *                 `type: String`, Mongoose's default ObjectId casting
 *                 throws CastError on every audit insert.
 *
 *   `expiresAt` — Date, computed at insert by the pre('save') hook
 *                 from `timestamp + retentionDays(resource) * 86_400_000`.
 *                 Drives the collection's TTL index. The hook runs
 *                 pre-save (after `strict:false` bypass fields like
 *                 `resource` / `timestamp` are populated on `_doc`) —
 *                 a path-level `default()` would fire too early and
 *                 read `this.resource` as `undefined`.
 */

import mongoose, { Schema } from 'mongoose';
import { getRetentionDays } from '#config/sections/audit.config.js';

const auditSchema = new Schema(
  {
    _id: { type: String },
    // Filter-able read fields — declared so `strictQuery: true` doesn't
    // silently strip them from incoming query filters. Arc still owns
    // their write-side shape (we pass entry.* through unchanged).
    resource: { type: String, index: true },
    documentId: { type: String, index: true },
    action: { type: String, index: true },
    userId: { type: String },
    organizationId: { type: String },
    timestamp: { type: Date, index: true },
    expiresAt: { type: Date },
  },
  { strict: false, timestamps: false },
);

auditSchema.pre('save', function () {
  const doc = this as unknown as { expiresAt?: Date; get(path: string): unknown };
  if (doc.expiresAt) return;
  const resource = (doc.get('resource') as string | undefined) ?? '';
  const tsRaw = doc.get('timestamp');
  const ts = tsRaw instanceof Date ? tsRaw : tsRaw ? new Date(tsRaw as string) : new Date();
  const days = getRetentionDays(resource);
  doc.expiresAt = new Date(ts.getTime() + days * 86_400_000);
});

const AuditModel =
  mongoose.models.ArcAuditEntry ||
  mongoose.model('ArcAuditEntry', auditSchema, 'audit_logs');

export default AuditModel;
