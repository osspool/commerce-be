/**
 * Control-Account Resource Factory — DRY for customer-invoice / vendor-bill.
 *
 * Customer Invoices (A/R, account 1141) and Vendor Bills (A/P, account 2111)
 * are mirror surfaces over the SAME `JournalEntry` model — same query path,
 * same FSM, same open-items reconciliation read. Before this factory each
 * lived in a hand-written 170-line resource file with the only differences
 * being:
 *   - Control account code (1141 vs 2111)
 *   - Partner side ('receivable' vs 'payable')
 *   - Partner type ('customer' vs 'supplier')
 *   - Partner query key ('customerId' vs 'supplierId')
 *   - Resource name / displayName / tag / prefix
 *   - Bound action handlers (post/receive/debit-note vs post/pay/credit-note)
 *
 * The factory consumes that small config envelope and produces a fully wired
 * `defineResource()` value with:
 *   - Decorated repository — list/get/getOne filtered to JEs that touch the
 *     control account with a non-null `partnerId`
 *   - `GET /open` endpoint — open reconciliation items decorated with
 *     `partnerName` (joined from Customer or Supplier, batched)
 *   - Disabled CRUD writes — the only legitimate path is via `actions`
 *     (post/receive/pay/note), which the caller supplies
 *
 * Adding a third side (e.g. employee advances over account 1142) means
 * writing one more config object — no new repo wrapper, no new open-items
 * handler, no copy-paste drift.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireOrgMembership } from '@classytic/arc/permissions';
import { getOrgId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import type mongoose from 'mongoose';
import { orgScoped } from '#shared/presets/index.js';
import { accounting, JournalEntry, journalEntryRepository } from '../accounting.engine.js';
import { controlAccountId } from '../posting/partner-posting.helper.js';
import { decorateNestedPartnerNames, type PartnerType } from './partner-resolver.service.js';

// biome-ignore lint/suspicious/noExplicitAny: the actions block is parametrized by the caller's domain
type ResourceActions = Record<string, any>;
// Arc applies a single PermissionCheck across all actions on a resource —
// callers pass the canonical role gate (e.g. `requireRoles('admin', 'finance_admin')`).
// biome-ignore lint/suspicious/noExplicitAny: PermissionCheck is the runtime predicate
type ResourceActionPermissions = any;

export interface ControlAccountResourceConfig {
  /** Semantic side. Drives terminology in summaries and the default partnerType. */
  side: 'receivable' | 'payable';
  /** Chart-of-accounts code for the control account (e.g. '1141' for A/R). */
  controlCode: string;
  /** Customer or Supplier — used to batch-resolve partner names on `/open`. */
  partnerType: PartnerType;
  /** Query string key for filtering `/open` by a single partner. */
  partnerQueryKey: 'customerId' | 'supplierId';

  // Resource identity
  name: string;
  displayName: string;
  tag: string;
  prefix: string;

  /** Declarative actions block forwarded to `defineResource({ actions })`. */
  actions: ResourceActions;
  /** Per-action permissions forwarded to `defineResource({ actionPermissions })`. */
  actionPermissions: ResourceActionPermissions;
  /**
   * Extra routes appended to the auto-generated `/open` route. Use for
   * non-CRUD, non-action endpoints (e.g. bulk-pay, summaries) that the
   * factory doesn't know about.
   */
  // biome-ignore lint/suspicious/noExplicitAny: arc route definitions are flexible
  extraRoutes?: any[];
}

type JournalRepo = typeof journalEntryRepository;

// The reconciliations.getOpenItems() row puts the JE journal-item under a
// nested `.item` field — partnerId / partnerType live there, not at the
// top level. We decorate via `decorateNestedPartnerNames` (with explicit
// path-getters) instead of the flat decorator.
interface OpenItemRow {
  item?: { partnerId?: string | null; partnerType?: PartnerType | null };
  // biome-ignore lint/suspicious/noExplicitAny: kernel surface evolves; we only touch partner fields
  [k: string]: any;
}

/**
 * Decorate the journal-entry repo so list/get only surface JEs whose items
 * touch the chosen control account WITH a non-null partnerId. Other reads
 * (anything Arc routes through repository methods we don't override) pass
 * through unchanged so audit + hooks + actions still work.
 *
 * Why guard `getById` defensively: Arc's compound reads call `getOne`, but
 * direct `findById` style lookups (used by some legacy actions) bypass that.
 * Wrapping both keeps the filter monotone — once a JE is determined to be
 * "of this side", every entry point agrees.
 */
function wrapControlAccountRepo(controlCode: string): JournalRepo {
  const base = journalEntryRepository;
  const wrapped: JournalRepo = Object.create(base);

  const elemMatch = async () => ({
    $elemMatch: { account: await controlAccountId(controlCode), partnerId: { $ne: null } },
  });

  (wrapped as { getAll: JournalRepo['getAll'] }).getAll = async function getAll(params, options) {
    const parsedParams = (params ?? {}) as Record<string, unknown>;
    const filters = { ...((parsedParams.filters ?? {}) as Record<string, unknown>) };
    filters.journalItems = await elemMatch();
    return base.getAll({ ...parsedParams, filters }, options);
  } as JournalRepo['getAll'];

  if (typeof base.getOne === 'function') {
    (wrapped as { getOne: NonNullable<JournalRepo['getOne']> }).getOne = async function getOne(
      filter,
      options,
    ) {
      const merged = { ...((filter ?? {}) as Record<string, unknown>) };
      merged.journalItems = await elemMatch();
      // biome-ignore lint/suspicious/noExplicitAny: extended filter passed through to base
      return (base.getOne as any).call(base, merged, options);
    } as NonNullable<JournalRepo['getOne']>;
  }

  (wrapped as { getById: JournalRepo['getById'] }).getById = async function getById(id, options) {
    const doc = await base.getById(id, options);
    if (!doc) return null;
    const accId = await controlAccountId(controlCode);
    const items =
      (doc as { journalItems?: Array<{ account: unknown; partnerId?: string | null }> })
        .journalItems ?? [];
    const isMatch = items.some((i) => String(i.account) === String(accId) && i.partnerId);
    return isMatch ? doc : null;
  } as JournalRepo['getById'];

  return wrapped;
}

type AnyReply = { send: (x: unknown) => unknown };

export function defineControlAccountResource(config: ControlAccountResourceConfig) {
  const cachedAccountId: { current: mongoose.Types.ObjectId | null } = { current: null };
  async function accountIdOnce() {
    if (!cachedAccountId.current) cachedAccountId.current = await controlAccountId(config.controlCode);
    return cachedAccountId.current;
  }

  type OpenReq = RequestWithExtras & { query?: Record<string, string | undefined> };

  async function openItemsHandler(req: OpenReq, reply: AnyReply) {
    const orgId = getOrgId(req.scope);
    const partnerId = req.query?.[config.partnerQueryKey];
    const accId = await accountIdOnce();
    const open = (await accounting.repositories.reconciliations.getOpenItems({
      accountId: accId,
      organizationId: orgId,
      ...(partnerId ? { filter: { partnerId } } : {}),
    } as never)) as OpenItemRow[];

    const decorated = await decorateNestedPartnerNames(
      open,
      (r) => r.item?.partnerId ?? null,
      (r) => (r.item?.partnerType as PartnerType | undefined) ?? null,
      config.partnerType,
    );
    return reply.send(decorated);
  }

  return defineResource({
    name: config.name,
    audit: true,
    displayName: config.displayName,
    tag: config.tag,
    prefix: config.prefix,

    adapter: createMongooseAdapter({
      model: JournalEntry,
      repository: wrapControlAccountRepo(config.controlCode),
      schemaGenerator: (m, arcOptions) =>
        buildCrudSchemasFromModel(m, {
          ...(arcOptions as Record<string, unknown>),
          softRequiredFields: ['journalType', 'date', 'totalDebit', 'totalCredit', 'state'],
        } as Parameters<typeof buildCrudSchemasFromModel>[1]),
    }),
    queryParser: new QueryParser({ maxLimit: 100 }),
    presets: [orgScoped],

    // Writes go through `actions` (post / receive / pay / note) so the
    // double-entry + period-lock + idempotency contracts always run.
    disabledRoutes: ['create', 'update', 'delete'],

    schemaOptions: {
      excludeFields: ['journalItems', 'referenceNumber'],
      fieldRules: {
        organizationId: { systemManaged: true },
      },
    },

    permissions: {
      list: requireOrgMembership(),
      get: requireOrgMembership(),
    },

    actions: config.actions,
    actionPermissions: config.actionPermissions,

    routes: [
      {
        method: 'GET',
        path: '/open',
        summary: `List open ${config.side === 'receivable' ? 'A/R' : 'A/P'} items (optionally filtered by ${config.partnerType})`,
        permissions: requireOrgMembership(),
        raw: true,
        // biome-ignore lint/suspicious/noExplicitAny: Arc's raw handler typing is permissive
        handler: openItemsHandler as any,
      },
      ...(config.extraRoutes ?? []),
    ],
  });
}
