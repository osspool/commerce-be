import purchaseService from './purchase.service.js';

/**
 * Purchase Controller
 *
 * HTTP handlers for stock purchase (entry) operations.
 * All purchases are recorded at head office only.
 */
class PurchaseController {
  /**
   * Record a purchase (batch stock entry)
   * POST /inventory/purchases
   */
  async create(req, reply) {
    try {
      const result = await purchaseService.recordPurchase(req.body, req.user._id);

      const statusCode = result.errors?.length ? 207 : 201; // 207 = Multi-Status
      return reply.code(statusCode).send({
        success: result.success,
        ...result,
        message: result.success
          ? `${result.summary.totalItems} items added to stock`
          : `${result.summary.totalItems} items added, ${result.summary.errors} errors`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Add stock for a single item
   * POST /inventory/purchases/single
   */
  async addStock(req, reply) {
    try {
      const result = await purchaseService.addStock(req.body, req.user._id);
      return reply.code(201).send({
        success: true,
        ...result,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Get purchase history
   * GET /inventory/purchases/history
   */
  async getHistory(req, reply) {
    try {
      const { page, limit, ...filters } = req.query;
      const result = await purchaseService.getPurchaseHistory(filters, { page, limit });
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  }
}

export default new PurchaseController();
