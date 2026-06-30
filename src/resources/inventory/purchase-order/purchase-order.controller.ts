/**
 * Purchase Controller — extends Arc's BaseController
 *
 * Overrides only `create` / `update` where business logic (invoice
 * numbering, supplier lookup, totals, normalization, auto-approve/receive
 * chain) lives. `list`/`get`/`delete` flow through the adapter + mongokit
 * repository — no proxying, no `RepositoryLike` aliasing.
 *
 * `delete` is hard-disabled on the domain side: purchases are an
 * immutable audit trail; use `action: cancel` instead.
 */

import type { AnyRecord, IControllerResponse, IRequestContext } from '@classytic/arc';
import { BaseController, ValidationError } from '@classytic/arc';

// `executeGetQuery`'s option bag (`ParsedQuery`) and reason union
// (`FetchDenialReason`) are declared by arc but not re-exported from the
// package root, so mirror them structurally rather than reaching into a deep
// dist path. `Record<string, unknown>` is a valid (wider) override param type.
type GetQueryOptions = Record<string, unknown>;
type FetchDenialReason = 'NOT_FOUND' | 'POLICY_FILTERED' | 'ORG_SCOPE_DENIED';
import { createStatusError } from '../shared/status-errors.js';
import purchaseOrderRepository from './purchase-order.repository.js';
import purchaseOrderService from './purchase-order.service.js';

/**
 * Always-on supplier populate for the HTTP detail (`GET /:id`) path — same
 * `{ _id, name, code }` projection the list / by-query paths get via the
 * repository's `before:getAll/getByQuery/getOne` hooks.
 *
 * Why it's wired HERE and not on `before:getById`: internal action callers
 * (approve / receive / pay / cancel / update-draft) call
 * `purchaseOrderRepository.getById(id, { lean: true })` and rely on
 * `purchase.supplier` staying a bare ObjectId (`String(purchase.supplier)`
 * for partner ref + transaction tagging — a populated object would stringify
 * to `'[object Object]'`). Under `tenantField: false`, Arc's detail path no
 * longer needs a compound filter, so `fetchDetailed` resolves via
 * `repository.getById` (NOT `getOne`) — the populate hook never fires and the
 * wire payload shipped a bare ref. Injecting the populate only into the
 * controller's HTTP `get` options keeps internal getById calls bare.
 */
const SUPPLIER_DISPLAY_POPULATE = { path: 'supplier', model: 'Supplier', select: 'name code' };

class PurchaseOrderController extends BaseController {
  constructor() {
    super(purchaseOrderRepository, {
      // Company-wide — POs are head-office/company-scoped: the doc carries a
      // `branch` ref to the resolved head-office branch, never a per-request
      // `organizationId`. The create override below bypasses BaseController's
      // org-stamping (it delegates to purchaseOrderService), so PO docs have
      // no `organizationId`. purchase 0.2's `injectTenantField` still leaves
      // an (optional, unindexed) `organizationId` PATH on the schema even
      // under `tenant: false`, so Arc can't auto-infer company-scope and a
      // custom controller defaults `tenantField → 'organizationId'`. That
      // default makes list scope to an org the doc lacks (empty list) and
      // `GET /:id` fail `checkOrgScope` (404). Declare `false` here — the
      // custom controller does NOT inherit the resource's `tenantField`.
      tenantField: false,
      schemaOptions: {
        fieldRules: {
          invoiceNumber: { systemManaged: true },
          status: { systemManaged: true },
          paymentStatus: { systemManaged: true },
          paidAmount: { systemManaged: true },
          dueAmount: { systemManaged: true },
          subTotal: { systemManaged: true },
          discountTotal: { systemManaged: true },
          taxTotal: { systemManaged: true },
          grandTotal: { systemManaged: true },
          statusHistory: { systemManaged: true },
          createdBy: { systemManaged: true },
          approvedBy: { systemManaged: true },
          receivedBy: { systemManaged: true },
          // Approval chain fields — mutated only via submit_for_approval /
          // decide actions; never via PATCH.
          approvals: { systemManaged: true },
          approvalPolicyId: { systemManaged: true },
          approvalPolicyVersion: { systemManaged: true },
        },
      },
    });
  }

  override async create(ctx: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const actorId = String(ctx.user?._id || ctx.user?.id || '');
    const purchase = await purchaseOrderService.createPurchase(ctx.body as AnyRecord, actorId);
    return { data: purchase as AnyRecord, status: 201 };
  }

  /**
   * Inject the supplier populate into the HTTP detail (`GET /:id`) query so
   * the response ships a populated `{ _id, name, code }` supplier (see
   * `SUPPLIER_DISPLAY_POPULATE`). Internal `getById` callers go through the
   * repository directly and stay unaffected.
   */
  protected override async executeGetQuery(
    id: string,
    options: GetQueryOptions,
    req: IRequestContext,
  ): Promise<{ doc: AnyRecord | null; reason: FetchDenialReason | null }> {
    const withPopulate = {
      ...options,
      populate: options.populate ?? [SUPPLIER_DISPLAY_POPULATE],
    };
    return (
      super.executeGetQuery as (
        id: string,
        options: GetQueryOptions,
        req: IRequestContext,
      ) => Promise<{ doc: AnyRecord | null; reason: FetchDenialReason | null }>
    )(id, withPopulate, req);
  }

  override async update(ctx: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const id = String(ctx.params?.id || '');
    if (!id) throw new ValidationError('ID parameter is required');
    const actorId = String(ctx.user?._id || ctx.user?.id || '');
    const purchase = await purchaseOrderService.updateDraftPurchase(id, ctx.body as AnyRecord, actorId);
    return { data: purchase as AnyRecord, status: 200 };
  }

  override async delete(): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    throw createStatusError('Deleting purchases is not allowed — use action:cancel', 405);
  }
}

// Lazy singleton — BaseController's constructor accesses the repository,
// which lazy-loads the engine model. Defer construction to first use so
// module-load doesn't race the engine boot.
let _instance: PurchaseOrderController | null = null;
const purchaseOrderController = new Proxy({} as PurchaseOrderController, {
  get(_target, prop, receiver) {
    if (!_instance) _instance = new PurchaseOrderController();
    return Reflect.get(_instance, prop, receiver);
  },
});

export default purchaseOrderController;
