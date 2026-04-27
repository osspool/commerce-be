/**
 * Vendor Bills Resource — A/P view over JournalEntry
 *
 * Vendor bills are not a separate model — they are JournalEntry docs whose
 * journalItems carry a partnerId on the A/P control account (2111). The
 * resource therefore shares ledger's JournalEntry model, but list and
 * single-doc reads are filtered down to AP-shaped entries via a decorated
 * repository (mirrors `wrapProductRepo` in product.resource.factory.ts).
 *
 * Routes:
 *   GET  /                       — auto, filtered to A/P bills for this branch
 *   GET  /:id                    — auto, 404 unless the JE is an A/P bill
 *   GET  /open                   — open A/P items by reconciliation (custom)
 *   POST /:id/action             — declarative state transitions (post/pay/credit-note)
 *
 * Create / update / delete are intentionally disabled — bill JEs are
 * created through the `post` action and mutated only through `pay` /
 * `credit-note` (which enforce double-entry and idempotency contracts).
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { requireOrgMembership } from '@classytic/arc/permissions';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import type mongoose from 'mongoose';
import { orgScoped } from '#shared/presets/index.js';
import { Account, accounting, JournalEntry, journalEntryRepository } from '../accounting.engine.js';
import {
  vendorBillActionPermissions,
  vendorBillActions,
} from './vendor-bill.actions.js';

const AP_CONTROL_CODE = '2111';

let cachedApId: mongoose.Types.ObjectId | null = null;
async function apAccountId(): Promise<mongoose.Types.ObjectId> {
  if (cachedApId) return cachedApId;
  const acc = await Account.findOne({ accountTypeCode: AP_CONTROL_CODE }).select('_id').lean();
  if (!acc) {
    throw Object.assign(new Error('A/P control account 2111 not seeded'), {
      statusCode: 503,
      code: 'CHART_NOT_SEEDED',
    });
  }
  cachedApId = acc._id as mongoose.Types.ObjectId;
  return cachedApId;
}

type JournalRepo = typeof journalEntryRepository;

/**
 * Decorate the journal entry repo so list/get only surface A/P-shaped JEs:
 * those with at least one journal item on the 2111 control account that
 * carries a non-null partnerId.
 *
 * Arc routes single-doc reads through `getOne(filter)` with a compound
 * filter ({ _id, organizationId, ... }) — never `getById` directly, so we
 * wrap `getOne` (and `getById` for defensive coverage). Every other method
 * passes through so arc's pipeline (audit, hooks) keeps working for actions.
 */
function wrapVendorBillRepo(): JournalRepo {
  const base = journalEntryRepository;
  const wrapped: JournalRepo = Object.create(base);

  const apElemMatch = async () => ({
    $elemMatch: { account: await apAccountId(), partnerId: { $ne: null } },
  });

  (wrapped as { getAll: JournalRepo['getAll'] }).getAll = async function getAll(params, options) {
    const parsedParams = (params ?? {}) as Record<string, unknown>;
    const filters = { ...((parsedParams.filters ?? {}) as Record<string, unknown>) };
    filters.journalItems = await apElemMatch();
    return base.getAll({ ...parsedParams, filters }, options);
  } as JournalRepo['getAll'];

  if (typeof base.getOne === 'function') {
    (wrapped as { getOne: NonNullable<JournalRepo['getOne']> }).getOne = async function getOne(
      filter,
      options,
    ) {
      const merged = { ...((filter ?? {}) as Record<string, unknown>) };
      merged.journalItems = await apElemMatch();
      // biome-ignore lint/suspicious/noExplicitAny: passing extended filter through to base
      return (base.getOne as any).call(base, merged, options);
    } as NonNullable<JournalRepo['getOne']>;
  }

  (wrapped as { getById: JournalRepo['getById'] }).getById = async function getById(id, options) {
    const doc = await base.getById(id, options);
    if (!doc) return null;
    const apId = await apAccountId();
    const items =
      (doc as { journalItems?: Array<{ account: unknown; partnerId?: string | null }> })
        .journalItems ?? [];
    const isAp = items.some((i) => String(i.account) === String(apId) && i.partnerId);
    return isAp ? doc : null;
  } as JournalRepo['getById'];

  return wrapped;
}

const queryParser = new QueryParser({ maxLimit: 100 });

type AnyReq = {
  query?: Record<string, string>;
  scope?: { organizationId?: string };
  user?: { organizationId?: string; orgId?: string };
  headers?: Record<string, string | undefined>;
};
type AnyReply = { send: (x: unknown) => unknown };

function getOrgId(req: AnyReq): string | undefined {
  return (
    req.scope?.organizationId ??
    req.user?.organizationId ??
    req.user?.orgId ??
    req.headers?.['x-organization-id']
  );
}

async function openBillsHandler(req: AnyReq, reply: AnyReply) {
  const orgId = getOrgId(req);
  const supplierId = req.query?.supplierId;
  const apId = await apAccountId();
  const open = await accounting.repositories.reconciliations.getOpenItems({
    accountId: apId,
    organizationId: orgId,
    ...(supplierId ? { filter: { partnerId: supplierId } } : {}),
  } as never);
  return reply.send({ success: true, data: open });
}

const vendorBillResource = defineResource({
  name: 'vendor-bill',
  audit: true,
  displayName: 'Vendor Bills',
  tag: 'Accounting - Vendor Bills (A/P)',
  prefix: '/accounting/vendor-bills',

  adapter: createMongooseAdapter({
    model: JournalEntry,
    repository: wrapVendorBillRepo(),
    schemaGenerator: (m, arcOptions) =>
      buildCrudSchemasFromModel(m, {
        ...(arcOptions as Record<string, unknown>),
        softRequiredFields: ['journalType', 'date', 'totalDebit', 'totalCredit', 'state'],
      } as Parameters<typeof buildCrudSchemasFromModel>[1]),
  }),
  queryParser,
  presets: [orgScoped],

  // CRUD writes are routed through declarative actions instead — the only
  // legitimate way to create/mutate an A/P bill JE is via post/pay/credit-note.
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

  actions: vendorBillActions,
  actionPermissions: vendorBillActionPermissions,

  routes: [
    {
      method: 'GET',
      path: '/open',
      summary: 'List open A/P items (optionally filtered by supplier)',
      permissions: requireOrgMembership(),
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: handler is a thin wrapper around accounting reconciliations
      handler: openBillsHandler as any,
    },
  ],
});

export default vendorBillResource;
