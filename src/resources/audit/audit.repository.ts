/**
 * MongoKit Repository for `audit_logs`.
 *
 * Single instance shared between two consumers:
 *   1. Arc's audit plugin (in `register-infra-plugins`) — for writes via
 *      `repository-audit-adapter` when the audit logger persists entries.
 *   2. The resource adapter (in `audit.resource.ts`) — for the
 *      auto-generated LIST / GET routes that mongokit's getAll handles
 *      natively, with filter parsing through the shared QueryParser.
 *
 * The hooks below adapt the SDK's flat-style query-string contract
 * (`?module=…&from=…&to=…&action=a,b`) to mongo filter shape, and remap
 * the stored `_id` (Arc's `aud_…` string) back to `id` on responses so
 * the SDK's `AuditEntry` shape stays stable.
 *
 * Hook payload shapes (mongokit/repo-core convention):
 *   - `before:*`  emits the bare `RepositoryContext` object
 *   - `after:*`   emits `{ context, result }`
 *   - `error:*`   emits `{ context, error }`
 */

import { Repository } from '@classytic/mongokit';
import mongoose from 'mongoose';
// Subpath specifier — keeps the ESM cache key consistent with consumers
// that import via `#resources/audit/...` (register-infra-plugins,
// audit.resource, audit.controller, audit.indexes). Mixing relative
// and subpath specifiers makes tsx evaluate the model module twice and
// register a duplicate Mongoose model.
import AuditModel from '#resources/audit/audit.model.js';

/** Module → audited-resource fanout. Mirrors the SDK's RESOURCE_MODULE map. */
const MODULE_RESOURCES: Record<string, readonly string[]> = {
  inventory: ['transfer', 'purchase', 'supplier', 'stock-request'],
  accounting: ['account', 'journal-entry', 'fiscal-period', 'budget'],
  sales: ['order', 'customer', 'transaction'],
  commerce: ['branch', 'member', 'user'],
};

/**
 * Look up Better-Auth `user` documents in batch and return a
 * `userId → { name, email }` map. Reads via the raw mongoose connection
 * (mongokit doesn't model the BA collection — it's owned by the auth
 * plugin) and projects only the fields we need so the audit-row enrich
 * stays cheap on large pages.
 *
 * Returns an empty map on any failure — actor name is a UX nicety, not
 * a security boundary, so we never let a denormalisation lookup break
 * the audit-log read path.
 */
async function lookupActors(
  userIds: readonly string[],
): Promise<Map<string, { name?: string; email?: string }>> {
  const out = new Map<string, { name?: string; email?: string }>();
  if (userIds.length === 0) return out;
  try {
    const db = mongoose.connection.db;
    if (!db) return out;
    // Probe both `id` (BA's logical string id) and `_id` (raw mongo).
    // BA's user collection in this deployment uses string ids, but
    // matching `_id` defensively keeps the helper alive across future
    // schema migrations (ObjectId mirror, custom collation, …) without
    // a code change. The mongo driver's typed `Filter<Document>` only
    // permits ObjectId in `_id: { $in }`; we cast to a loose shape to
    // bypass the constraint — mongo itself accepts string ids fine.
    const filter = {
      $or: [
        { id: { $in: userIds as string[] } },
        { _id: { $in: userIds as string[] } },
      ],
    } as unknown as Parameters<ReturnType<typeof db.collection>['find']>[0];
    const docs = await db
      .collection('user')
      .find(filter)
      .project({ _id: 1, id: 1, name: 1, email: 1 })
      .toArray();
    for (const doc of docs) {
      const key = (doc.id as string | undefined) ?? String(doc._id);
      out.set(key, {
        name: doc.name as string | undefined,
        email: doc.email as string | undefined,
      });
    }
  } catch {
    // Best-effort: actor name is a UX nicety, not a security boundary.
    // Lookup failure (collection missing, permission denied, transient
    // mongo blip) degrades the table to "show truncated userId" — never
    // blocks the audit-log read path.
  }
  return out;
}

/** Translate a flat-style `filters` bag into mongo predicates in place. */
function translatePresentationFilters(filters: Record<string, unknown>): void {
  // ?module=inventory  →  resource: { $in: [...] }
  // Case-insensitive: the FE filter dropdown sends "Inventory" /
  // "Accounting" (titlecase) but the keys here are lowercase. Lowercase
  // the lookup so both shapes work.
  if (typeof filters.module === 'string') {
    const list = MODULE_RESOURCES[filters.module.toLowerCase()];
    if (list) filters.resource = { $in: list };
    delete filters.module;
  }

  // ?action=create,update  →  action: { $in: [...] }
  if (typeof filters.action === 'string' && filters.action.includes(',')) {
    filters.action = { $in: filters.action.split(',') };
  }

  // ?from=…&to=…  →  timestamp: { $gte, $lte }
  if (filters.from || filters.to) {
    const range: Record<string, Date> = {};
    if (filters.from) range.$gte = new Date(String(filters.from));
    if (filters.to) range.$lte = new Date(String(filters.to));
    filters.timestamp = range;
    delete filters.from;
    delete filters.to;
  }
}

interface AuditDoc {
  _id?: unknown;
  id?: string;
  userId?: string;
  actorName?: string;
  actorEmail?: string;
  [key: string]: unknown;
}

/** Stamp `id` (string of `_id`) on each doc so the SDK's contract holds. */
function projectIdFromUnderscore(doc: AuditDoc): AuditDoc {
  if (doc.id !== undefined || doc._id === undefined) return doc;
  doc.id = String(doc._id);
  return doc;
}

/**
 * Stamp `actorName` + `actorEmail` on each doc by joining `userId` against
 * Better-Auth's `user` collection. ONE round-trip for the whole page —
 * de-dupes ids first so the `$in` query stays bounded.
 *
 * Idempotent: if the FE/SDK ever evolves to pre-resolve actor names at
 * write time, the existing fields win and we skip the lookup.
 */
async function enrichActors(docs: AuditDoc[]): Promise<void> {
  const ids = new Set<string>();
  for (const doc of docs) {
    if (doc.userId && !doc.actorName && !doc.actorEmail) ids.add(doc.userId);
  }
  if (ids.size === 0) return;
  const actors = await lookupActors([...ids]);
  for (const doc of docs) {
    if (!doc.userId) continue;
    if (doc.actorName || doc.actorEmail) continue;
    const actor = actors.get(doc.userId);
    if (!actor) continue;
    if (actor.name) doc.actorName = actor.name;
    if (actor.email) doc.actorEmail = actor.email;
  }
}

class AuditRepository extends Repository {
  constructor() {
    super(AuditModel);
    this._setupHooks();
  }

  private _setupHooks(): void {
    // Filter translation stays as a sync hook — pure mutation of the
    // params bag before mongokit dispatches the query. Sort default and
    // actor enrichment live in the `getAll` / `getById` overrides below
    // because: (a) the hook payload doesn't always plumb through to
    // mongokit's parser cleanly for `sort` and (b) mongokit's emitter
    // doesn't reliably await async `after:*` listeners, so a hook-based
    // join would race the response.
    this.on('before:getAll', (payload) => {
      const context = payload as Record<string, unknown>;
      const filters = context.filters as Record<string, unknown> | undefined;
      if (filters) translatePresentationFilters(filters);

      // The SDK sends `?offset=N&limit=M` (skip-style pagination).
      // mongokit's QueryParser only knows `page` / `limit`, so `offset`
      // lands in filters. Translate to page = floor(offset/limit) + 1.
      if (filters && filters.offset !== undefined) {
        const offset = Number(filters.offset);
        const limit = Number(context.limit ?? filters.limit ?? 20);
        if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
          context.page = Math.floor(offset / limit) + 1;
        }
        delete filters.offset;
      }
    });
  }
}

/**
 * Helpers exposed for the controller layer (not the resource adapter)
 * because mongokit's `methodRegistryPlugin` wraps `getAll` / `getById`
 * at base-Repository constructor time, and class-level overrides on
 * the subclass never get called by `BaseController.list`. The
 * controller layer sits ABOVE the registry, so it can run the same
 * logic reliably.
 */
export { enrichActors, projectIdFromUnderscore };
export type { AuditDoc };

const auditRepository = new AuditRepository();

export default auditRepository;
