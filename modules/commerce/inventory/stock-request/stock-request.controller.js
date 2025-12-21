import stockRequestService from './stock-request.service.js';

/**
 * Stock Request Controller
 *
 * HTTP handlers for stock request operations.
 */
class StockRequestController {
  /**
   * Create a new stock request
   * POST /inventory/requests
   */
  async create(req, reply) {
    try {
      const request = await stockRequestService.createRequest(req.body, req.user._id);
      return reply.code(201).send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} submitted`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * List stock requests
   * GET /inventory/requests
   */
  async list(req, reply) {
    try {
      const { page, limit, sort, ...filters } = req.query;
      const result = await stockRequestService.listRequests(filters, { page, limit, sort });
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

  /**
   * Get request by ID
   * GET /inventory/requests/:id
   */
  async getById(req, reply) {
    try {
      const request = await stockRequestService.getById(req.params.id);
      if (!request) {
        return reply.code(404).send({
          success: false,
          error: 'Stock request not found',
        });
      }
      return reply.send({
        success: true,
        data: request,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Get pending requests for review
   * GET /inventory/requests/pending
   */
  async getPending(req, reply) {
    try {
      const result = await stockRequestService.getPendingForReview();
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

  /**
   * Approve a stock request
   * POST /inventory/requests/:id/approve
   */
  async approve(req, reply) {
    try {
      const request = await stockRequestService.approveRequest(
        req.params.id,
        req.body?.items,
        req.body?.reviewNotes,
        req.user._id
      );
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} approved`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Reject a stock request
   * POST /inventory/requests/:id/reject
   */
  async reject(req, reply) {
    try {
      const request = await stockRequestService.rejectRequest(
        req.params.id,
        req.body?.reason,
        req.user._id
      );
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} rejected`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Fulfill a request by creating transfer
   * POST /inventory/requests/:id/fulfill
   */
  async fulfill(req, reply) {
    try {
      const result = await stockRequestService.fulfillRequest(
        req.params.id,
        req.body,
        req.user._id
      );
      return reply.send({
        success: true,
        data: result,
        message: `Request fulfilled. Transfer ${result.transfer.challanNumber} created.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Cancel a stock request
   * POST /inventory/requests/:id/cancel
   */
  async cancel(req, reply) {
    try {
      const request = await stockRequestService.cancelRequest(
        req.params.id,
        req.body?.reason,
        req.user._id
      );
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} cancelled`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}

export default new StockRequestController();
