/**
 * Scan Resource Definition — barcode/QR/RFID resolution
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { flowCtx, flow } from './helpers.js';
import { scanSchemas } from '../inventory-flow.schemas.js';

const scanResource = defineResource({
  name: 'scan',
  displayName: 'Scan Resolution',
  tag: 'Inventory - Scan',
  prefix: '/inventory/scan',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/resolve',
      summary: 'Resolve barcode/SKU/lot/serial token',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      schema: scanSchemas.resolve,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const { token } = req.body as { token: string };
        const result = await flow().services.scan.resolve(token, ctx);
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default scanResource;
