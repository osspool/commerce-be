/**
 * Transfer Resource Definition
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { transferController, transferSchemas } from './index.js';

const transferResource = defineResource({
  name: 'transfer',
  audit: true,
  displayName: 'Transfers',
  tag: 'Inventory - Transfers',
  prefix: '/inventory/transfers',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create stock transfer',
      permissions: permissions.inventory.transferCreate,
      wrapHandler: false,
      schema: transferSchemas.createTransferSchema,
      handler: transferController.create.bind(transferController),
    },
    {
      method: 'GET',
      path: '/',
      summary: 'List transfers',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      schema: transferSchemas.listTransfersSchema,
      handler: transferController.list.bind(transferController),
    },
    {
      method: 'GET',
      path: '/stats',
      summary: 'Get transfer statistics',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      handler: transferController.getStats.bind(transferController),
    },
    {
      method: 'GET',
      path: '/export',
      summary: 'Export transfers to CSV',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      handler: transferController.exportTransfers.bind(transferController),
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get transfer details',
      permissions: permissions.inventory.transferView,
      wrapHandler: false,
      schema: transferSchemas.getTransferSchema,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        if (id.startsWith('TRF-') || id.match(/^[A-Z]{3}-\d{6}-\d+$/i))
          return transferController.getByDocumentNumber(req, reply);
        return transferController.getById(req, reply);
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update transfer',
      permissions: permissions.inventory.transferCreate,
      wrapHandler: false,
      schema: transferSchemas.updateTransferSchema,
      handler: transferController.update.bind(transferController),
    },
  ],
});

export default transferResource;
