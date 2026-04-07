import type { FastifyRequest, FastifyReply } from 'fastify';
import transferService from './transfer.service.js';
import permissions from '#config/permissions.js';

/**
 * Transfer Controller
 *
 * HTTP handlers for stock transfer (transfer) operations.
 */
class TransferController {
  /**
   * Create a new transfer
   * POST /inventory/transfers
   */
  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string; role?: string[] };
      const userRoles = Array.isArray(user?.role) ? user.role : [];
      const hasRole = (allowed: string[] = []): boolean => allowed.some((role) => userRoles.includes(role));

      const transfer = await transferService.createTransfer(
        req.body as Record<string, unknown>,
        user._id || (user.id as string),
        {
          canSubBranchTransfer: hasRole([...(permissions.inventory.subBranchTransfer._roles || [])]),
          canReturnToHead: hasRole([...(permissions.inventory.returnToHead._roles || [])]),
        },
      );
      return reply.code(201).send({
        success: true,
        data: transfer,
        message: `Transfer ${transfer.documentNumber} created successfully`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * List transfers
   * GET /inventory/transfers
   */
  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { page, limit, sort, ...filters } = req.query as Record<string, string>;
      const result = await transferService.listTransfers(filters, { page: Number(page), limit: Number(limit), sort });
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

  /**
   * Get transfer by ID
   * GET /inventory/transfers/:id
   */
  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = req.params as { id: string };
      const transfer = await transferService.getById(id);
      if (!transfer) {
        return reply.code(404).send({
          success: false,
          error: 'Transfer not found',
        });
      }
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Get transfer by document number
   * GET /inventory/transfers/:documentNumber
   */
  async getByDocumentNumber(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = req.params as { id: string };
      const transfer = await transferService.getByDocumentNumber(id);
      if (!transfer) {
        return reply.code(404).send({
          success: false,
          error: 'Transfer not found',
        });
      }
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Update a draft transfer
   * PATCH /inventory/transfers/:id
   */
  async update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const transfer = await transferService.updateTransfer(
        id,
        req.body as Record<string, unknown>,
        (user._id || user.id) as string,
      );
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Approve a transfer
   * POST /inventory/transfers/:id/approve
   */
  async approve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const transfer = await transferService.approveTransfer(id, (user._id || user.id) as string);
      return reply.send({
        success: true,
        data: transfer,
        message: `Transfer ${transfer.documentNumber} approved`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Dispatch a transfer
   * POST /inventory/transfers/:id/dispatch
   */
  async dispatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const body = req.body as { transport?: Record<string, unknown> } | undefined;
      const transfer = await transferService.dispatchTransfer(id, body?.transport, (user._id || user.id) as string);
      return reply.send({
        success: true,
        data: transfer,
        message: `Transfer ${transfer.documentNumber} dispatched. Stock decremented from head office.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Mark transfer as in transit
   * PATCH /inventory/transfers/:id/in-transit
   */
  async markInTransit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const transfer = await transferService.markInTransit(id, (user._id || user.id) as string);
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Receive a transfer
   * POST /inventory/transfers/:id/receive
   */
  async receive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const body = req.body as { items?: Array<Record<string, unknown>> } | undefined;
      const transfer = await transferService.receiveTransfer(id, body?.items, (user._id || user.id) as string);
      return reply.send({
        success: true,
        data: transfer,
        message: `Transfer ${transfer.documentNumber} received. Stock added to sub-branch.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Cancel a transfer
   * POST /inventory/transfers/:id/cancel
   */
  async cancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const user = req.user as { _id?: string; id?: string };
      const { id } = req.params as { id: string };
      const body = req.body as { reason?: string } | undefined;
      const transfer = await transferService.cancelTransfer(id, body?.reason, (user._id || user.id) as string);
      return reply.send({
        success: true,
        data: transfer,
        message: `Transfer ${transfer.documentNumber} cancelled`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Get transfer statistics
   * GET /inventory/transfers/stats
   */
  async getStats(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const stats = await transferService.getStats(req.query as Record<string, string>);
      return reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Export transfers to CSV
   * GET /inventory/transfers/export
   */
  async exportTransfers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { limit, ...filters } = req.query as Record<string, string>;
      const exportLimit = Math.min(parseInt(limit, 10) || 10000, 50000);

      const result = await transferService.listTransfers(filters, {
        limit: exportLimit,
        sort: '-createdAt',
        populate: true,
      });

      // Convert to CSV
      const csvRows: string[] = [];

      csvRows.push(
        [
          'Transfer ID',
          'Transfer Number',
          'Transfer Type',
          'Document Type',
          'Status',
          'Sender Branch ID',
          'Sender Branch Name',
          'Receiver Branch ID',
          'Receiver Branch Name',
          'Total Items',
          'Total Quantity',
          'Total Value',
          'Created At',
          'Created By',
          'Approved At',
          'Approved By',
          'Dispatched At',
          'Dispatched By',
          'Received At',
          'Received By',
          'Vehicle Number',
          'Driver Name',
          'Driver Phone',
          'Remarks',
        ].join(','),
      );

      interface TransferRow {
        _id: unknown;
        documentNumber?: string;
        transferType?: string;
        documentType?: string;
        status?: string;
        senderBranch?: { _id?: unknown; name?: string } | string;
        receiverBranch?: { _id?: unknown; name?: string } | string;
        totalItems?: number;
        totalQuantity?: number;
        totalValue?: number;
        createdAt?: string | Date;
        createdBy?: string;
        approvedAt?: string | Date;
        approvedBy?: string;
        dispatchedAt?: string | Date;
        dispatchedBy?: string;
        receivedAt?: string | Date;
        receivedBy?: string;
        transport?: { vehicleNumber?: string; driverName?: string; driverPhone?: string };
        remarks?: string;
      }

      for (const transfer of (result.docs || []) as TransferRow[]) {
        const senderBranch = transfer.senderBranch as { _id?: unknown; name?: string } | string | undefined;
        const receiverBranch = transfer.receiverBranch as { _id?: unknown; name?: string } | string | undefined;
        const row = [
          transfer._id,
          transfer.documentNumber || '',
          transfer.transferType || '',
          transfer.documentType || '',
          transfer.status || '',
          typeof senderBranch === 'object' ? senderBranch?._id || '' : senderBranch || '',
          typeof senderBranch === 'object' && senderBranch?.name ? `"${senderBranch.name.replace(/"/g, '""')}"` : '',
          typeof receiverBranch === 'object' ? receiverBranch?._id || '' : receiverBranch || '',
          typeof receiverBranch === 'object' && receiverBranch?.name
            ? `"${receiverBranch.name.replace(/"/g, '""')}"`
            : '',
          transfer.totalItems || 0,
          transfer.totalQuantity || 0,
          transfer.totalValue || 0,
          transfer.createdAt ? new Date(transfer.createdAt).toISOString() : '',
          transfer.createdBy || '',
          transfer.approvedAt ? new Date(transfer.approvedAt).toISOString() : '',
          transfer.approvedBy || '',
          transfer.dispatchedAt ? new Date(transfer.dispatchedAt).toISOString() : '',
          transfer.dispatchedBy || '',
          transfer.receivedAt ? new Date(transfer.receivedAt).toISOString() : '',
          transfer.receivedBy || '',
          transfer.transport?.vehicleNumber || '',
          transfer.transport?.driverName || '',
          transfer.transport?.driverPhone || '',
          transfer.remarks ? `"${transfer.remarks.replace(/"/g, '""')}"` : '',
        ];
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\n');
      const filename = `transfers-${new Date().toISOString().split('T')[0]}.csv`;

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  }
}

export default new TransferController();
