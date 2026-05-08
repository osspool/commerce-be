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
import { createStatusError } from '../shared/status-errors.js';
import purchaseOrderRepository from './purchase-order.repository.js';
import purchaseOrderService from './purchase-order.service.js';

class PurchaseOrderController extends BaseController {
  constructor() {
    super(purchaseOrderRepository, {
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
