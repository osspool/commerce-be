/**
 * Audit Logs Controller
 *
 * Extends Arc's `BaseController` for auto LIST + GET-by-id with the
 * shared mongokit `QueryParser` already wired by `defineResource`.
 *
 * Two critical settings:
 *
 *   1. `tenantField: false` — Arc's default of `'organizationId'` would
 *      inject `{ organizationId: <currentOrg> }` into every filter. Audit
 *      rows can carry a null/missing `organizationId` (e.g. system-
 *      initiated ops outside any branch context); with the default the
 *      list filter is silently zeroed out, exactly the symptom
 *      `branch.controller.ts` documents at line 17–22.
 *
 *   2. `list` / `get` overrides below — mongokit's `methodRegistryPlugin`
 *      wraps `Repository.getAll` / `getById` at construction time, so
 *      class-level overrides on `AuditRepository` never fire from
 *      `BaseController`. The controller layer sits ABOVE the method
 *      registry, so doing the work here is reliable. Two adjustments
 *      land in this layer:
 *
 *        a. **Default sort: `{ timestamp: -1 }`** when the caller
 *           didn't supply one. Auditors expect newest activity at the
 *           top; without this they'd page through 80+ days of history
 *           to reach today's row.
 *
 *        b. **Actor enrichment** — batch-resolve `userId → user.name /
 *           user.email` from Better-Auth's `user` collection so the FE
 *           can render human-readable actor labels without N+1 round
 *           trips. Best-effort: lookup failures degrade silently to the
 *           raw userId (see `enrichActors` in `audit.repository.ts`).
 *
 * Filter-shape massaging (module → resource $in, from/to → timestamp
 * range) lives in the repository's `before:getAll` hook where it applies
 * uniformly to every read path — including arc's own audit-plugin
 * queries — without going through the registry.
 */

import {
  type AnyRecord,
  BaseController,
  type IControllerResponse,
  type IRequestContext,
  type ListResult,
} from '@classytic/arc';
// Subpath specifier (not `./`) — keeps the ESM cache key consistent with
// `register-infra-plugins.ts` so writes (arc audit plugin) and reads
// (this controller) target the same Repository instance. See
// `tests/support/preload-resources.ts` for the same gotcha.
import auditRepository, {
  enrichActors,
  projectIdFromUnderscore,
  type AuditDoc,
} from '#resources/audit/audit.repository.js';

class AuditController extends BaseController<AnyRecord> {
  constructor() {
    super(auditRepository, {
      tenantField: false,
    });
  }

  async list(req: IRequestContext): Promise<IControllerResponse<ListResult<AnyRecord>>> {
    // Default sort: newest first. Caller-supplied `?sort=…` wins because
    // the QueryParser populates `req.query.sort` BEFORE this method runs;
    // we only set the default when nothing came in.
    const query = req.query as Record<string, unknown> | undefined;
    if (query && query.sort === undefined) {
      query.sort = '-timestamp';
    }

    const response = await super.list(req);
    const data = (response as { data?: unknown }).data;

    // Walk the response shape and enrich. mongokit's offset envelope
    // wraps the rows under `data` (so `response.data.data` is the array);
    // raw arrays come back un-wrapped. Both branches are idempotent —
    // `projectIdFromUnderscore` short-circuits when `id` is set, and
    // `enrichActors` skips rows that already carry actorName/email.
    if (Array.isArray(data)) {
      const docs = data as AuditDoc[];
      for (const d of docs) projectIdFromUnderscore(d);
      await enrichActors(docs);
    } else if (data && typeof data === 'object') {
      const inner = (data as { data?: AuditDoc[]; docs?: AuditDoc[] });
      const rows = inner.data ?? inner.docs;
      if (Array.isArray(rows)) {
        for (const d of rows) projectIdFromUnderscore(d);
        await enrichActors(rows);
      }
    }
    return response;
  }

  async get(req: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const response = (await super.get(req)) as IControllerResponse<AnyRecord>;
    const doc = (response as { data?: unknown }).data;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const auditDoc = doc as AuditDoc;
      projectIdFromUnderscore(auditDoc);
      await enrichActors([auditDoc]);
    }
    return response;
  }
}

export default new AuditController();
