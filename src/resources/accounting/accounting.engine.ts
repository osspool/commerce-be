/**
 * Accounting Engine — Top-Level Eager Singleton (ledger 0.8.0)
 *
 * The engine OWNS all models and repositories. It is created at module
 * import time as a top-level const, mirroring the @classytic/promo and
 * fajr-be-arc reference patterns. No init function, no lazy getters.
 *
 * Why this works without a connected DB at import time: Mongoose model
 * registration only requires `mongoose.connection` (the default connection
 * object) to exist — no live socket. Schemas are compiled and models
 * registered immediately; queries simply queue or fail until
 * `connectDatabase()` runs in the app boot. By the time any handler runs,
 * the connection is open.
 *
 * Usage:
 *   import { JournalEntry, journalEntryRepository } from '../accounting.engine.js';
 */

import { createBdTaxResolver } from '@classytic/bd-tax';
import { createAccountingEngine, registerJournalType } from '@classytic/ledger';
import { bangladeshPack } from '@classytic/ledger-bd';
import mongoose from 'mongoose';
import config from '#config/index.js';
import { dayCloseLockPlugin } from './posting/period-lock-guard.js';
import { mergeResolvers, type TaxResolver } from './tax/tax-resolver.js';

export { bangladeshPack as bdPack };

// ─── Tax Resolver ──────────────────────────────────────────────────────────
//
// The country tax pack (bd-tax) plugs in here via structural typing —
// `createBdTaxResolver()` returns an object whose shape satisfies the
// TaxResolver interface declared in `./tax/tax-resolver.ts`. If bd-tax
// drifts, this line fails to compile. No shared abstraction package; same
// pattern as every `@classytic/*` repo fitting mongokit's `Repository<TDoc>`.
//
// Deployments can inject extra tax classes via config.accounting.extraTaxClasses
// (e.g. a bespoke NGO exemption class awarded by SRO amendment) — they merge
// on top of the country pack's seed without patching published packages.

export const taxResolver: TaxResolver = (() => {
  const base = createBdTaxResolver();
  const extras = config.accounting.extraTaxClasses ?? [];
  return extras.length ? mergeResolvers(base, extras) : base;
})();

// ─── Budget Status Values ───────────────────────────────────────────────────

export const BUDGET_STATUS_VALUES = ['draft', 'submitted', 'approved', 'rejected', 'closed'] as const;

// ─── Custom journal types — registered before engine creation ──────────────
// (the JournalEntry schema reads the type enum at construction time)
//
// Wrapped in `safeRegisterJournalType` because tsx + vitest can re-evaluate
// this module under a different ESM specifier (subpath `#resources/...` vs
// relative `../accounting.engine.js`), producing two distinct module
// records for the same file. The ledger package's `_frozen` flag is
// process-global, so the second evaluation's raw `registerJournalType()`
// call throws "Cannot register journal types after schema initialization"
// even though the registration is identical to the first. The guard
// converts that into a no-op so module re-evaluation is idempotent.
//
// Production (single eval) behaviour is unchanged — types register on
// the first call, the schema freezes after `createAccountingEngine`,
// and any subsequent registration would still throw if it attempted a
// new type that wasn't there before.

function safeRegisterJournalType(code: string, def: { code: string; name: string; description: string }): void {
  try {
    registerJournalType(code, def);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Re-evaluation: schema already frozen from the first eval. Same
    // code is being re-registered — silently no-op.
    if (message.includes('after schema initialization')) return;
    // Genuine misuse — code mismatch, missing fields, override of a
    // built-in type. Re-throw so the developer sees it.
    throw err;
  }
}

safeRegisterJournalType('POS_SALES', {
  code: 'POS_SALES',
  name: 'POS Sales Journal',
  description: 'Point-of-sale transactions aggregated by day per branch',
});
safeRegisterJournalType('ECOM_SALES', {
  code: 'ECOM_SALES',
  name: 'E-Commerce Sales Journal',
  description: 'Online order transactions posted per-order',
});

// COD lifecycle — three journal types carve a clean audit trail:
//   ECOM_SALES_COD            — placement: Dr 1141 A/R | Cr 4111 Revenue (+VAT)
//   ECOM_SALES_COD_SETTLEMENT — settlement: Dr 1112 Bank + Dr 6423 Commission + Dr 6702 Writeoff | Cr 1141
//   ECOM_SALES_COD_REVERSAL   — cancel-before-settle: mirror of placement
// See be-prod/src/resources/accounting/posting/contracts/cod-*.contract.ts.
safeRegisterJournalType('ECOM_SALES_COD', {
  code: 'ECOM_SALES_COD',
  name: 'COD Placement Journal',
  description: 'Cash-on-delivery order placement — A/R debited, reclassified on settlement',
});
safeRegisterJournalType('ECOM_SALES_COD_SETTLEMENT', {
  code: 'ECOM_SALES_COD_SETTLEMENT',
  name: 'COD Settlement Journal',
  description: 'COD reconciliation — Bank + Commission + optional Writeoff, clears A/R',
});
safeRegisterJournalType('ECOM_SALES_COD_REVERSAL', {
  code: 'ECOM_SALES_COD_REVERSAL',
  name: 'COD Cancellation Reversal',
  description: 'Contra of COD placement when order is cancelled before settlement',
});

// ─── Engine ─────────────────────────────────────────────────────────────────

export const accounting = createAccountingEngine({
  mongoose: mongoose.connection,
  country: bangladeshPack,
  currency: 'BDT',
  multiCurrency: {
    enabled: true,
    currencies: ['USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'JPY'],
  },
  fiscalYearStartMonth: config.accounting.fiscalYearStartMonth,
  audit: { trackActor: true },
  strictness: { immutable: true, requireActor: true },
  idempotency: true,
  // Single-company-multi-branch — accounts/fiscal periods are company-wide,
  // but every JE carries the originating branch ID for partition reports.
  // The schema declaration lives below in `schemaOptions.journalEntry`.
  journalEntryOrgField: 'organizationId',
  // Repository pagination caps. Mongokit's Repository.list defaults to
  // maxLimit=100, which clips the BD chart of accounts (~150+ rows). Set
  // here so every consumer of the engine sees the same cap — no resource
  // file should hardcode this.
  pagination: {
    account: { maxLimit: 1000 },
    // Bounded set (~12 periods/year × N years), admin-only — generous cap.
    // Default is 100 in mongokit's Repository, which clips multi-year views.
    fiscalPeriod: { maxLimit: 500 },
  },
  // Day-close lock — blocks entries whose date falls in a closed branch
  // day. Hooks both `before:create` (manual creates + reversals) and
  // `before:update` (post/unpost/archive — ledger 0.5.1 routes these
  // through the update pipeline). Fiscal-period close at the company
  // level is enforced by the ledger's built-in fiscalLockPlugin.
  //
  // Day-close lock — standardized on ledger 0.7's `createLockPlugin` +
  // `watermarkResolver`. The plugin uses a lazy Proxy for JournalEntryModel
  // so it works inside the engine initializer (TDZ-safe).
  plugins: {
    journalEntry: [dayCloseLockPlugin()],
  },
  // NO multiTenant — single company, multi-branch.
  // Account + FiscalPeriod are company-wide (no org field).
  // JournalEntry + Budget get organizationId via extraFields below.
  schemaOptions: {
    journalEntry: {
      indexes: true,
      autoReference: true,
      textSearch: true,
      extraFields: {
        /** Branch that created this entry (optional tag, not a filter) */
        organizationId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'organization',
          default: null,
          index: true,
        },
        /** Links journal entry back to the originating commerce document.
         * sourceId is an opaque String + sourceModel ref (ledger convention)
         * — not a Mongoose ObjectId. Allows cross-engine refs (Order, Purchase,
         * invoice numbers) without coupling ledger to each source's ID shape. */
        sourceRef: {
          sourceModel: { type: String, default: null },
          sourceId: { type: String, default: null },
        },
        /** Free-form provenance the host attaches per posting. Today the COGS
         * pipeline tags `{ costMissing, affectedLines }` here so the admin
         * "missing cost" view can `find({ 'metadata.costMissing': true })`
         * without joining out to a separate audit collection. Schema-less by
         * design — different posting sources stamp whatever they need. */
        metadata: {
          type: mongoose.Schema.Types.Mixed,
          default: null,
        },
      },
      extraIndexes: [
        { fields: { 'sourceRef.sourceId': 1 }, options: { sparse: true } },
        {
          fields: { organizationId: 1, 'sourceRef.sourceModel': 1, date: -1 },
          options: { sparse: true },
        },
        // Drives the "cost data missing" admin view — finance grepts
        // these to identify which products need backfill. Sparse so it
        // only indexes entries that actually carry the flag.
        {
          fields: { 'metadata.costMissing': 1, date: -1 },
          options: { sparse: true },
        },
      ],
      // Subsidiary-ledger dimensions on journal items. ledger 0.7 exposes
      // `extraItemFields` so we can tag every line with a partner without
      // creating a separate Partner model. Supplier._id and Customer._id
      // are stringified into `partnerId`; `partnerType` disambiguates the
      // two since a single control account is never shared between them.
      // generateAgedBalance / generatePartnerLedger read these fields via
      // `contactField: 'journalItems.partnerId'`.
      extraItemFields: {
        partnerId: { type: String, default: null, index: true },
        partnerType: { type: String, default: null },
      },
    },
    budget:
      config.accounting.mode !== 'simple'
        ? {
            extraFields: {
              /** Branch that owns this budget (required — budgets are per-branch) */
              organizationId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'organization',
                required: true,
                index: true,
              },
              status: {
                type: String,
                enum: BUDGET_STATUS_VALUES,
                default: 'draft',
                index: true,
              },
              category: { type: String, default: null, trim: true },
              notes: { type: String, default: null },
              revision: { type: Number, default: 1, min: 1 },
              submittedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
              submittedAt: { type: Date, default: null },
              approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
              approvedAt: { type: Date, default: null },
              rejectedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
              rejectedAt: { type: Date, default: null },
              rejectionReason: { type: String, default: null },
            },
            extraIndexes: [
              { fields: { organizationId: 1, status: 1 }, options: {} },
              { fields: { organizationId: 1, category: 1, periodStart: 1 }, options: {} },
            ],
          }
        : undefined,
  },
});

// ─── Direct model exports ──────────────────────────────────────────────────
// Cast to Model<any> matches the fajr-be-arc / reference pattern. Ledger
// surfaces models as Model<unknown>; until we generate typed Doc interfaces,
// `any` keeps consumer code free of repeated narrowing.

// biome-ignore lint/suspicious/noExplicitAny: consumer-side model is loosely typed
export const Account = accounting.models.Account as mongoose.Model<any>;
// biome-ignore lint/suspicious/noExplicitAny: consumer-side model is loosely typed
export const JournalEntry = accounting.models.JournalEntry as mongoose.Model<any>;
// biome-ignore lint/suspicious/noExplicitAny: consumer-side model is loosely typed
export const FiscalPeriod = accounting.models.FiscalPeriod as mongoose.Model<any>;
// biome-ignore lint/suspicious/noExplicitAny: consumer-side model is loosely typed
export const Budget =
  config.accounting.mode !== 'simple'
    ? (accounting.models.Budget as mongoose.Model<any>)
    : (null as unknown as mongoose.Model<any>);

// ─── Direct repository exports ─────────────────────────────────────────────

export const accountRepository = accounting.repositories.accounts;
export const journalEntryRepository = accounting.repositories.journalEntries;
export const fiscalPeriodRepository = accounting.repositories.fiscalPeriods;
export const budgetRepository = config.accounting.mode !== 'simple' ? accounting.repositories.budgets : null;

// ─── Auto-increment budget revision on update ──────────────────────────────
// (mode-gated; was previously inside initAccountingEngine)

if (config.accounting.mode !== 'simple') {
  const BudgetSchema = (accounting.models.Budget as mongoose.Model<unknown>).schema;
  BudgetSchema.pre('findOneAndUpdate', function (this: mongoose.Query<unknown, unknown>) {
    this.setUpdate({ ...this.getUpdate(), $inc: { revision: 1 } });
  });
}

export default accounting;
