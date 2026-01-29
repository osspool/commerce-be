import { BaseController } from '@classytic/arc';
import purchaseInvoiceService from './purchase-invoice.service.js';
import { purchaseSchemaOptions } from './purchase.schemas.js';

class PurchaseController extends BaseController {
  constructor() {
    super(purchaseInvoiceService, { schemaOptions: purchaseSchemaOptions });
  }

  async create(context) {
    try {
      const userId = context.user?._id || context.user?.id;
      const result = await purchaseInvoiceService.createPurchase(context.body, userId);

      return {
        success: true,
        data: result,
        status: 201,
        meta: { message: 'Purchase invoice created successfully' },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.statusCode || 400,
      };
    }
  }

  async update(context) {
    try {
      const userId = context.user?._id || context.user?.id;
      const result = await purchaseInvoiceService.updateDraftPurchase(
        context.params.id,
        context.body,
        userId
      );

      return {
        success: true,
        data: result,
        status: 200,
        meta: { message: 'Purchase invoice updated successfully' },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.statusCode || 400,
      };
    }
  }
}

export default new PurchaseController();
