import type { FastifyRequest, FastifyReply } from 'fastify';
import stockRequestService from './stock-request.service.js';

/**
 * Stock Request Controller
 *
 * HTTP handlers for stock request operations.
 */
class StockRequestController {
  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id: string };
      const request = await stockRequestService.createRequest(req.body as Record<string, unknown>, user._id);
      return reply.code(201).send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} submitted`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { page, limit, sort, ...filters } = req.query as Record<string, string>;
      const result = (await stockRequestService.listRequests(filters, {
        page: Number(page),
        limit: Number(limit),
        sort,
      })) as Record<string, unknown>;
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = req.params as { id: string };
      const request = await stockRequestService.getById(id);
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
        error: (error as Error).message,
      });
    }
  }

  async getPending(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const result = await stockRequestService.getPendingForReview();
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async approve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id: string };
      const { id } = req.params as { id: string };
      const body = req.body as { items?: Array<Record<string, unknown>>; reviewNotes?: string } | undefined;
      const request = await stockRequestService.approveRequest(id, body?.items, body?.reviewNotes, user._id);
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} approved`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async reject(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id: string };
      const { id } = req.params as { id: string };
      const body = req.body as { reason?: string } | undefined;
      const request = await stockRequestService.rejectRequest(id, body?.reason, user._id);
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} rejected`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async fulfill(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id: string };
      const { id } = req.params as { id: string };
      const result = await stockRequestService.fulfillRequest(id, req.body as Record<string, unknown>, user._id);
      return reply.send({
        success: true,
        data: result,
        message: `Request fulfilled. Transfer ${result.transfer.documentNumber} created.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async cancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id: string };
      const { id } = req.params as { id: string };
      const body = req.body as { reason?: string } | undefined;
      const request = await stockRequestService.cancelRequest(id, body?.reason, user._id);
      return reply.send({
        success: true,
        data: request,
        message: `Request ${request.requestNumber} cancelled`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }
}

export default new StockRequestController();
