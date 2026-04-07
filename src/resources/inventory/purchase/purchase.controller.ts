import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse, AnyRecord } from '@classytic/arc';
import purchaseInvoiceService from './purchase-invoice.service.js';
import { purchaseSchemaOptions } from './purchase.schemas.js';

class PurchaseController extends BaseController {
  constructor() {
    super(purchaseInvoiceService as unknown as import('@classytic/arc').RepositoryLike, {
      schemaOptions: purchaseSchemaOptions,
    });
  }

  override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    try {
      const userId = context.user?._id || context.user?.id;
      const result = await purchaseInvoiceService.createPurchase(
        context.body as Parameters<typeof purchaseInvoiceService.createPurchase>[0],
        userId,
      );

      return {
        success: true,
        data: result as AnyRecord,
        status: 201,
        meta: { message: 'Purchase invoice created successfully' },
      };
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      return {
        success: false,
        error: err.message,
        status: err.statusCode || 400,
      };
    }
  }

  override async update(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    try {
      const userId = context.user?._id || context.user?.id;
      const result = await purchaseInvoiceService.updateDraftPurchase(
        context.params.id,
        context.body as Parameters<typeof purchaseInvoiceService.updateDraftPurchase>[1],
        userId,
      );

      return {
        success: true,
        data: result as AnyRecord,
        status: 200,
        meta: { message: 'Purchase invoice updated successfully' },
      };
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      return {
        success: false,
        error: err.message,
        status: err.statusCode || 400,
      };
    }
  }
}

export default new PurchaseController();
