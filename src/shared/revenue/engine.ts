/**
 * Revenue Engine Singleton — @classytic/revenue v2
 *
 * One `createRevenue()` call per process, cached and accessed via `getRevenueEngine()`.
 * See @revenue/revenue/PACKAGE_RULES.md — repositories ARE the API surface.
 *
 * Why a singleton?
 *   - Revenue owns its Mongoose models; two engines would register duplicate
 *     models on the same connection and catalog-warn.
 *   - Mongokit plugin hooks (`after:update`, etc.) are subscribed once at init
 *     and routed to the app's outbox / accounting bridge.
 *   - Wiring ManualProvider once avoids recreating circular state on hot reload.
 *
 * Revenue v2 owns the model names: `RevenueTransaction`, `RevenueSubscription`,
 * `RevenueSettlement`. New data lands in `revenuetransactions` — existing
 * data in the old `transactions` collection can be migrated.
 */

import { createRevenue, type RevenueBridges, type RevenueEngine } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import type { Connection } from 'mongoose';
import mongoose from 'mongoose';

export interface RevenueEngineInitOptions {
  connection?: Connection;
  logger?: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
    debug: (...a: unknown[]) => void;
  };
  isProduction?: boolean;
}

let engine: RevenueEngine | null = null;
let pending: Promise<RevenueEngine> | null = null;

/**
 * Source bridge — resolves polymorphic `sourceId`/`sourceModel` refs to real
 * docs. be-prod is single-connection Mongoose, so the default Mongoose
 * registry lookup works. Other deployments (microservices, external REST)
 * would implement this differently. See PACKAGE_RULES §7.
 */
const defaultSourceBridge: RevenueBridges['source'] = {
  async resolve(sourceId, sourceModel) {
    const Model = mongoose.connection.models[sourceModel];
    if (!Model) return null;
    return await Model.findById(sourceId).lean().exec();
  },
};

/**
 * Extra fields be-prod stores on its transactions beyond what revenue v2 ships
 * natively. These all have to be explicit — revenue is strict about unknown
 * fields (no Schema.Types.Mixed free-for-all).
 */
const transactionExtraFields = {
  // Ecommerce domain fields
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, enum: ['web', 'pos', 'api'], default: 'web', index: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', sparse: true, index: true },
  branchCode: { type: String, trim: true },
  description: { type: String },
  notes: { type: String },

  // Lifecycle timestamps not in revenue v2 core
  initiatedAt: { type: Date },
  completedAt: { type: Date },

  // Banking / reconciliation
  reconciliation: {
    isReconciled: { type: Boolean },
    reconciledAt: { type: Date },
    reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    bankStatementRef: { type: String },
  },

  // Reporting anchor date (defaults to createdAt in revenue v2, but reports
  // query against an explicit `date` field for backdated manual entries)
  date: { type: Date, default: Date.now, index: true },
};

const transactionExtraIndexes = [
  { fields: { date: -1, _id: -1 } as Record<string, 1 | -1> },
  { fields: { flow: 1, status: 1 } as Record<string, 1 | -1> },
  { fields: { source: 1, status: 1 } as Record<string, 1 | -1> },
  { fields: { branch: 1, date: -1 } as Record<string, 1 | -1> },
];

export async function initRevenueEngine(options: RevenueEngineInitOptions = {}): Promise<RevenueEngine> {
  if (engine) return engine;

  const connection = options.connection ?? mongoose.connection;

  engine = await createRevenue({
    connection,
    defaultCurrency: 'BDT',
    autoIndex: process.env.NODE_ENV !== 'production',
    // Immediate-payment gateway aliases all point at the single ManualProvider
    // instance. The bridge passes `gateway: 'cash'|'bkash'|...` as both the
    // provider lookup key AND the `method` field stamped on the transaction
    // — so registering aliases lets reports/accounting segment by actual
    // method (cash vs bkash vs nagad → different DR account in the ledger
    // posting handler) while reusing one provider impl.
    //
    // BD-specific MFS providers (bKash/Nagad/Rocket/Upay) start as manual-
    // verify entries (admin pastes TrxID); a real `@classytic/revenue-bkash`
    // provider can replace the alias later with zero handler/bridge edits.
    providers: (() => {
      const manual = new ManualProvider();
      return {
        manual,
        cash: manual,
        bank_transfer: manual,
        cod: manual,
        pos: manual,
        card: manual,
        bkash: manual,
        nagad: manual,
        rocket: manual,
        upay: manual,
      };
    })(),
    bridges: {
      source: defaultSourceBridge,
    },
    modules: {
      subscription: true,
      escrow: true,
      settlement: false,
    },
    schemaOptions: {
      transaction: {
        extraFields: transactionExtraFields,
        extraIndexes: transactionExtraIndexes,
      },
    },
    scope: false,
    logger: options.logger,
  });

  return engine;
}

/**
 * Lazy-initialize the revenue engine on the default mongoose connection.
 * Same pending-promise pattern as order.engine.ts — safe for top-level
 * `await` in resource files because mongoose is connected before
 * `loadResources()` runs.
 */
export async function ensureRevenueEngine(options: RevenueEngineInitOptions = {}): Promise<RevenueEngine> {
  if (engine) return engine;

  if (!pending) {
    pending = initRevenueEngine(options);
  }

  return pending;
}

export function getRevenueEngine(): RevenueEngine {
  if (!engine) {
    throw new Error('Revenue engine not initialized. Call initRevenueEngine() or ensureRevenueEngine() first.');
  }
  return engine;
}

export function getTransactionModel() {
  return getRevenueEngine().models.Transaction;
}

export function getTransactionRepository() {
  return getRevenueEngine().repositories.transaction;
}

export function isRevenueReady(): boolean {
  return engine !== null;
}

export async function destroyRevenueEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
    pending = null;
  }
}
