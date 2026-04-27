/**
 * Customer Invoices Resource — A/R view over JournalEntry
 *
 * Customer invoices are not a separate model — they are JournalEntry docs
 * whose journalItems carry a partnerId on the A/R control account (1141).
 * The resource therefore shares ledger's JournalEntry model, but the list
 * and single-doc reads are filtered down to AR-shaped entries via a
 * decorated repository (mirrors `wrapProductRepo` in product.resource.factory.ts).
 *
 * Routes:
 *   GET  /                       — auto, filtered to A/R invoices for this branch
 *   GET  /:id                    — auto, 404 unless the JE is an A/R invoice
 *   GET  /open                   — open A/R items by reconciliation (custom)
 *   POST /:id/action             — declarative state transitions (post/receive/debit-note)
 *
 * Create / update / delete are intentionally disabled — invoice JEs are
 * created through the `post` action (which enforces the credit-limit gate
 * and double-entry contracts) and mutated only through `receive` / `debit-note`.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { requireOrgMembership } from '@classytic/arc/permissions';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import type mongoose from 'mongoose';
import { orgScoped } from '#shared/presets/index.js';
import { Account, accounting, JournalEntry, journalEntryRepository } from '../accounting.engine.js';
import {
  customerInvoiceActionPermissions,
  customerInvoiceActions,
} from './customer-invoice.actions.js';

const AR_CONTROL_CODE = '1141';

let cachedArId: mongoose.Types.ObjectId | null = null;
async function arAccountId(): Promise<mongoose.Types.ObjectId> {
  if (cachedArId) return cachedArId;
  const acc = await Account.findOne({ accountTypeCode: AR_CONTROL_CODE }).select('_id').lean();
  if (!acc) {
    throw Object.assign(new Error('A/R control account 1141 not seeded'), {
      statusCode: 503,
      code: 'CHART_NOT_SEEDED',
    });
  }
  cachedArId = acc._id as mongoose.Types.ObjectId;
  return cachedArId;
}

type JournalRepo = typeof journalEntryRepository;

/**
 * Decorate the journal entry repo so list/get only surface A/R-shaped JEs:
 * those with at least one journal item on the 1141 control account that
 * carries a non-null partnerId.
 *
 * Arc routes both list and single-doc reads through the repository. List
 * uses `getAll` (paginated). Single-doc reads go through `getOne(filter)`
 * with a compound filter ({ _id, organizationId, ... }) — never `getById`
 * directly, so we wrap `getOne` (and `getById` for defensive coverage).
 * Every other method passes through so arc's pipeline (audit, hooks) keeps
 * working for actions.
 */
function wrapCustomerInvoiceRepo(): JournalRepo {
  const base = journalEntryRepository;
  const wrapped: JournalRepo = Object.create(base);

  const arElemMatch = async () => ({
    $elemMatch: { account: await arAccountId(), partnerId: { $ne: null } },
  });

  (wrapped as { getAll: JournalRepo['getAll'] }).getAll = async function getAll(params, options) {
    const parsedParams = (params ?? {}) as Record<string, unknown>;
    const filters = { ...((parsedParams.filters ?? {}) as Record<string, unknown>) };
    filters.journalItems = await arElemMatch();
    return base.getAll({ ...parsedParams, filters }, options);
  } as JournalRepo['getAll'];

  if (typeof base.getOne === 'function') {
    (wrapped as { getOne: NonNullable<JournalRepo['getOne']> }).getOne = async function getOne(
      filter,
      options,
    ) {
      const merged = { ...((filter ?? {}) as Record<string, unknown>) };
      merged.journalItems = await arElemMatch();
      // biome-ignore lint/suspicious/noExplicitAny: passing extended filter through to base
      return (base.getOne as any).call(base, merged, options);
    } as NonNullable<JournalRepo['getOne']>;
  }

  (wrapped as { getById: JournalRepo['getById'] }).getById = async function getById(id, options) {
    const doc = await base.getById(id, options);
    if (!doc) return null;
    const arId = await arAccountId();
    const items =
      (doc as { journalItems?: Array<{ account: unknown; partnerId?: string | null }> })
        .journalItems ?? [];
    const isAr = items.some((i) => String(i.account) === String(arId) && i.partnerId);
    return isAr ? doc : null;
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

async function openInvoicesHandler(req: AnyReq, reply: AnyReply) {
  const orgId = getOrgId(req);
  const customerId = req.query?.customerId;
  const arId = await arAccountId();
  const open = await accounting.repositories.reconciliations.getOpenItems({
    accountId: arId,
    organizationId: orgId,
    ...(customerId ? { filter: { partnerId: customerId } } : {}),
  } as never);
  return reply.send({ success: true, data: open });
}

const customerInvoiceResource = defineResource({
  name: 'customer-invoice',
  audit: true,
  displayName: 'Customer Invoices',
  tag: 'Accounting - Customer Invoices (A/R)',
  prefix: '/accounting/customer-invoices',

  adapter: createMongooseAdapter({
    model: JournalEntry,
    repository: wrapCustomerInvoiceRepo(),
    schemaGenerator: (m, arcOptions) =>
      buildCrudSchemasFromModel(m, {
        ...(arcOptions as Record<string, unknown>),
        softRequiredFields: ['journalType', 'date', 'totalDebit', 'totalCredit', 'state'],
      } as Parameters<typeof buildCrudSchemasFromModel>[1]),
  }),
  queryParser,
  presets: [orgScoped],

  // CRUD writes are routed through declarative actions instead — the only
  // legitimate way to create/mutate an A/R invoice JE is via post/receive/
  // debit-note (which enforce double-entry, credit-limit, and idempotency).
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

  actions: customerInvoiceActions,
  actionPermissions: customerInvoiceActionPermissions,

  routes: [
    {
      method: 'GET',
      path: '/open',
      summary: 'List open A/R items (optionally filtered by customer)',
      permissions: requireOrgMembership(),
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: handler is a thin wrapper around accounting reconciliations
      handler: openInvoicesHandler as any,
    },
  ],
});

export default customerInvoiceResource;
