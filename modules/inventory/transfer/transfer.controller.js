import transferService from './transfer.service.js';
import permissions from '#config/permissions.js';

/**
 * Transfer Controller
 *
 * HTTP handlers for stock transfer (challan) operations.
 */
class TransferController {
  /**
   * Create a new transfer
   * POST /inventory/transfers
   */
  async create(req, reply) {
    try {
      const userRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
      const hasRole = (allowed = []) => allowed.some(role => userRoles.includes(role));

      const transfer = await transferService.createTransfer(req.body, req.user._id || req.user.id, {
        canSubBranchTransfer: hasRole(permissions.inventory.subBranchTransfer),
        canReturnToHead: hasRole(permissions.inventory.returnToHead),
      });
      return reply.code(201).send({
        success: true,
        data: transfer,
        message: `Challan ${transfer.challanNumber} created successfully`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * List transfers
   * GET /inventory/transfers
   */
  async list(req, reply) {
    try {
      const { page, limit, sort, ...filters } = req.query;
      const result = await transferService.listTransfers(filters, { page, limit, sort });
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
   * Get transfer by ID
   * GET /inventory/transfers/:id
   */
  async getById(req, reply) {
    try {
      const transfer = await transferService.getById(req.params.id);
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
        error: error.message,
      });
    }
  }

  /**
   * Get transfer by challan number
   * GET /inventory/challans/:challanNumber
   */
  async getByChallanNumber(req, reply) {
    try {
      const transfer = await transferService.getByChallanNumber(req.params.challanNumber);
      if (!transfer) {
        return reply.code(404).send({
          success: false,
          error: 'Challan not found',
        });
      }
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Update a draft transfer
   * PATCH /inventory/transfers/:id
   */
  async update(req, reply) {
    try {
      const transfer = await transferService.updateTransfer(req.params.id, req.body, req.user._id || req.user.id);
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Approve a transfer
   * POST /inventory/transfers/:id/approve
   */
  async approve(req, reply) {
    try {
      const transfer = await transferService.approveTransfer(req.params.id, req.user._id || req.user.id);
      return reply.send({
        success: true,
        data: transfer,
        message: `Challan ${transfer.challanNumber} approved`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Dispatch a transfer
   * POST /inventory/transfers/:id/dispatch
   */
  async dispatch(req, reply) {
    try {
      const transfer = await transferService.dispatchTransfer(
        req.params.id,
        req.body?.transport,
        req.user._id || req.user.id
      );
      return reply.send({
        success: true,
        data: transfer,
        message: `Challan ${transfer.challanNumber} dispatched. Stock decremented from head office.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Mark transfer as in transit
   * PATCH /inventory/transfers/:id/in-transit
   */
  async markInTransit(req, reply) {
    try {
      const transfer = await transferService.markInTransit(req.params.id, req.user._id || req.user.id);
      return reply.send({
        success: true,
        data: transfer,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Receive a transfer
   * POST /inventory/transfers/:id/receive
   */
  async receive(req, reply) {
    try {
      const transfer = await transferService.receiveTransfer(
        req.params.id,
        req.body?.items,
        req.user._id || req.user.id
      );
      return reply.send({
        success: true,
        data: transfer,
        message: `Challan ${transfer.challanNumber} received. Stock added to sub-branch.`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Cancel a transfer
   * POST /inventory/transfers/:id/cancel
   */
  async cancel(req, reply) {
    try {
      const transfer = await transferService.cancelTransfer(
        req.params.id,
        req.body?.reason,
        req.user._id || req.user.id
      );
      return reply.send({
        success: true,
        data: transfer,
        message: `Challan ${transfer.challanNumber} cancelled`,
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Get transfer statistics
   * GET /inventory/transfers/stats
   */
  async getStats(req, reply) {
    try {
      const stats = await transferService.getStats(req.query);
      return reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Export transfers to CSV
   * GET /inventory/transfers/export
   *
   * Query params:
   * - status: Filter by status
   * - senderBranch: Filter by sender branch
   * - receiverBranch: Filter by receiver branch
   * - transferType: Filter by type
   * - startDate/endDate: Date range filter
   * - limit: Max records to export (default: 10000, max: 50000)
   *
   * Returns CSV file with all transfer data for archival purposes.
   * Users should export data before the 2-year TTL cleanup.
   */
  async exportTransfers(req, reply) {
    try {
      const { limit, ...filters } = req.query;
      const exportLimit = Math.min(parseInt(limit) || 10000, 50000);

      const result = await transferService.listTransfers(filters, {
        limit: exportLimit,
        sort: '-createdAt',
        populate: true,
      });

      // Convert to CSV
      const csvRows = [];

      // CSV Header
      csvRows.push([
        'Transfer ID',
        'Challan Number',
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
      ].join(','));

      // CSV Data
      for (const transfer of result.docs || []) {
        const row = [
          transfer._id,
          transfer.challanNumber || '',
          transfer.transferType || '',
          transfer.documentType || '',
          transfer.status || '',
          transfer.senderBranch?._id || transfer.senderBranch || '',
          transfer.senderBranch?.name ? `"${transfer.senderBranch.name.replace(/"/g, '""')}"` : '',
          transfer.receiverBranch?._id || transfer.receiverBranch || '',
          transfer.receiverBranch?.name ? `"${transfer.receiverBranch.name.replace(/"/g, '""')}"` : '',
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
        error: error.message,
      });
    }
  }
}

export default new TransferController();
