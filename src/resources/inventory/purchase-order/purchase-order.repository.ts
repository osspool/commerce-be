import { Repository, requireField, validationChainPlugin } from '@classytic/mongokit';
import type { ClientSession, Model, PopulateOptions } from 'mongoose';
import type { IPurchaseOrder, IStatusHistory } from './purchase-order.constants.js';
import { getPurchaseEngine } from '#resources/inventory/_engines/purchase.engine.js';

// The package owns the model — exposed via the engine after init.
// `getPurchaseModel()` is a lazy getter so this module can be imported
// before the engine boots (Repository's constructor needs the model
// synchronously, so this file is only consumed via the lazy proxy below).
function getPurchaseModel(): Model<IPurchaseOrder> {
  return getPurchaseEngine().models.PurchaseOrder as unknown as Model<IPurchaseOrder>;
}

/**
 * Always-on populate for read paths. Display surfaces (list table, detail
 * sheet, print) all need `supplier.name` + `supplier.code`; without populate
 * the wire payload only carries the bare ObjectId and the FE has to make a
 * second `/suppliers` call to resolve. Project just the two display fields
 * so we don't fan out the whole supplier doc on every PO row.
 *
 * `model: 'Supplier'` is explicit because the package's PurchaseOrder schema
 * stores `supplier` as a bare ObjectId without a `ref:` (the package can't
 * import host-owned models). Mongoose needs the model name to resolve the
 * populate target.
 */
const SUPPLIER_DISPLAY_POPULATE: PopulateOptions = {
  path: 'supplier',
  model: 'Supplier',
  select: 'name code',
};

class PurchaseOrderRepository extends Repository<IPurchaseOrder> {
  constructor() {
    super(
      getPurchaseModel(),
      [validationChainPlugin([requireField('invoiceNumber', ['create']), requireField('branch', ['create'])])],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
    this._setupReadHooks();
  }

  /**
   * Inject `populate: [supplier]` into HTTP-shaped read paths so list /
   * detail responses ship a populated supplier object instead of the bare
   * ObjectId ref.
   *
   * Wired ONLY on `getAll` / `getOne` / `getByQuery` — these are the paths
   * Arc's BaseController takes for `GET /` (→ getAll) and `GET /:id`
   * (→ getOne with compound filter via AccessControl.fetchDetailed). The
   * `getById` path is left bare on purpose: internal callers in the
   * `actions/` folder (approve / receive / pay / cancel / update-draft)
   * call `purchaseOrderRepository.getById(id, { lean: true })` and rely
   * on `purchase.supplier` being a bare ObjectId for transaction tagging
   * and partner ref lookup. Auto-populating that path would break those
   * actions silently — `String(populatedDoc)` returns `'[object Object]'`.
   *
   * Mongokit's getAll/findAll picks up `context.populate` (line ~440 + ~554
   * of mongokit Repository.ts). `context.populateOptions` is NOT in that
   * chain — only `params.populateOptions` and `options.populateOptions`
   * are honored, neither of which a `before:*` hook can touch — so the
   * hook MUST set `context.populate`.
   */
  private _setupReadHooks(): void {
    const inject = (payload: unknown) => {
      const ctx = payload as { populate?: unknown };
      if (ctx.populate) return;
      ctx.populate = [SUPPLIER_DISPLAY_POPULATE];
    };
    this.on('before:getAll', inject);
    this.on('before:getByQuery', inject);
    this.on('before:getOne', inject);
  }

  async appendStatus(
    id: string,
    statusEntry: IStatusHistory,
    updates: Record<string, unknown> = {},
    options: { session?: ClientSession | null } = {},
  ): Promise<IPurchaseOrder | null> {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        ...updates,
        $push: { statusHistory: statusEntry },
      },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    ).lean();
  }

  async recordPayment(
    id: string,
    transactionId: string,
    paymentUpdate: Record<string, unknown> = {},
    options: { session?: ClientSession | null } = {},
  ): Promise<IPurchaseOrder | null> {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        $push: { transactionIds: transactionId },
        ...paymentUpdate,
      },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    ).lean();
  }
}

// Lazy singleton — the constructor needs the package's model from the engine,
// which isn't initialized until `initializePurchaseEngine()` runs in the
// inventory plugin. Construct on first property access (request time) so
// module-load doesn't race the engine boot.
let _instance: PurchaseOrderRepository | null = null;
const purchaseOrderRepository = new Proxy({} as PurchaseOrderRepository, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new PurchaseOrderRepository();
    return Reflect.get(_instance, prop, receiver);
  },
});

export default purchaseOrderRepository;
