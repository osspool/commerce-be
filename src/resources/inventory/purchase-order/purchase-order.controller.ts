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
import { BaseController } from '@classytic/arc';
import { createStatusError } from '../shared/status-errors.js';
import purchaseOrderRepository from './purchase-order.repository.js';
import purchaseOrderService from './purchase-order.service.js';

class PurchaseOrderController extends BaseController {
  constructor() {
    super(purchaseOrderRepository);
  }

  override async create(ctx: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    try {
      const actorId = String(ctx.user?._id || ctx.user?.id || '');
      const purchase = await purchaseOrderService.createPurchase(ctx.body as AnyRecord, actorId);
      return { success: true, data: purchase as AnyRecord, status: 201 };
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      return { success: false, error: err.message, status: err.statusCode || 400 };
    }
  }

  override async update(ctx: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    try {
      const id = String(ctx.params?.id || '');
      if (!id) return { success: false, error: 'ID parameter is required', status: 400 };
      const actorId = String(ctx.user?._id || ctx.user?.id || '');
      const purchase = await purchaseOrderService.updateDraftPurchase(id, ctx.body as AnyRecord, actorId);
      return { success: true, data: purchase as AnyRecord, status: 200 };
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      return { success: false, error: err.message, status: err.statusCode || 400 };
    }
  }

  override async delete(): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    const err = createStatusError('Deleting purchases is not allowed — use action:cancel', 405);
    return { success: false, error: err.message, status: err.statusCode };
  }
}

export default new PurchaseOrderController();
