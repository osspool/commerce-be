/**
 * Scan Resource — barcode / QR / RFID resolution.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { flow, flowCtxGuard } from '../shared/helpers.js';
import { scanSchemas } from './scan.schemas.js';
import { createDomainError, createError } from '@classytic/arc/utils';

const scanResource = defineResource({
  name: 'scan',
  displayName: 'Scan Resolution',
  tag: 'Inventory - Scan',
  prefix: '/inventory/scan',
  disableDefaultRoutes: true,
  routeGuards: [flowCtxGuard.preHandler],
  routes: [
    {
      method: 'POST',
      path: '/resolve',
      summary: 'Resolve barcode/SKU/lot/serial token',
      permissions: permissions.inventory.view,
      raw: true,
      schema: scanSchemas.resolve,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { token } = req.body as { token: string };
        try {
          const result = await flow().services.scan.resolve(token, ctx);
          return reply.send(result);
        } catch (err) {
          // Unrecognised tokens (non-GS1, malformed barcodes) shouldn't 500.
          // Return 400 with the parser's reason so clients can prompt the
          // operator to re-scan.
          const message = err instanceof Error ? err.message : 'Failed to resolve scan token';
          throw createDomainError('SCAN_UNRESOLVED', message, 400);
        }
      },
    },
  ],
});

export default scanResource;
