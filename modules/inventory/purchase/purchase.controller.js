import BaseController from '#core/base/BaseController.js';
import purchaseInvoiceService from './purchase-invoice.service.js';
import { purchaseSchemaOptions } from './purchase.schemas.js';

class PurchaseController extends BaseController {
  constructor() {
    super(purchaseInvoiceService, purchaseSchemaOptions);
  }

  async create(req, reply) {
    try {
      const result = await purchaseInvoiceService.createPurchase(req.body, req.user._id);
      return reply.code(201).send({ success: true, data: result });
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        success: false,
        error: error.message,
      });
    }
  }

  async update(req, reply) {
    try {
      const result = await purchaseInvoiceService.updateDraftPurchase(req.params.id, req.body, req.user._id);
      return reply.code(200).send({ success: true, data: result });
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        success: false,
        error: error.message,
      });
    }
  }
}

export default new PurchaseController();
