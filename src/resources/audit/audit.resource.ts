/**
 * Audit Logs Resource
 *
 * Read-only HTTP surface over the `audit_logs` collection. Writes happen
 * exclusively through Arc's audit plugin (`fastify.audit.create / update
 * / delete`); there is no API endpoint for creating / updating / deleting
 * audit rows.
 *
 * Auto-CRUD via `createMongooseAdapter` + `BaseController`. The repository
 * hooks at `audit.repository.ts` translate the SDK's flat-style query
 * params (`?module=…&from=…&to=…&action=a,b`) into mongo predicates and
 * project `_id → id` on every response, so consumers see the SDK's
 * `AuditEntry` shape regardless of which read endpoint they hit.
 *
 * Permissions:
 *
 *   • READ (list/get) — relaxed to admin / finance_admin / superadmin so
 *     HQ admins and finance reviewers can run forensics without needing
 *     a superadmin login. Audit rows are intrinsically sensitive (full
 *     before/after document state) so we still gate by elevated role —
 *     a regular cashier or branch manager can't read them. Aligns with
 *     ERPNext's "Auditor" role pattern.
 *
 *   • WRITE (create/update/delete) — `denyAll()`. The collection is
 *     append-only; arc's audit plugin owns the write path through
 *     `fastify.audit.*` and auto-cleanup runs via the TTL index on
 *     `expiresAt` (per-resource retention from `audit.config.ts`,
 *     5-year floor for NBR books-of-account). HTTP write verbs would
 *     bypass that contract and risk polluting the immutable trail.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { denyAll, requireRoles } from '@classytic/arc/permissions';
import { queryParser } from '#shared/query-parser.js';
// Use the `#resources/...` subpath specifier (not relative) so the ESM
// module cache key matches `register-infra-plugins.ts` — otherwise tsx
// resolves the two import sites as different URLs, evaluates
// `audit.repository.ts` twice, and the audit-plugin write path ends up
// using a different `auditRepository` instance than this resource's
// read path. Same gotcha documented in `tests/support/preload-resources.ts`.
import auditController from '#resources/audit/audit.controller.js';
import AuditModel from '#resources/audit/audit.model.js';
import auditRepository from '#resources/audit/audit.repository.js';

const auditReader = requireRoles(['superadmin', 'admin', 'finance_admin']);

export default defineResource({
  name: 'audit-log',
  displayName: 'Audit Logs',
  tag: 'Audit',
  prefix: '/audit-logs',

  adapter: createMongooseAdapter(AuditModel, auditRepository),
  controller: auditController,
  queryParser,

  permissions: {
    list: auditReader,
    get: auditReader,
    create: denyAll(),
    update: denyAll(),
    delete: denyAll(),
  },
});
