/**
 * Inventory Capabilities Resource
 *
 * Exposes the Flow engine mode + feature flags so the frontend can gate
 * enterprise-only UI (Quality, Tasks, Dispatch, RFID). Read-only, any
 * authenticated user may call this.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '#shared/permissions.js';
import config from '#config/index.js';
import { flow } from './warehouse/shared/helpers.js';

const capabilitiesResource = defineResource({
  name: 'inventory-capabilities',
  displayName: 'Inventory Capabilities',
  tag: 'Inventory',
  prefix: '/inventory/capabilities',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'Get inventory capabilities',
      description:
        'Returns the active Flow mode and feature flags derived from config. Frontends use this to gate enterprise-only pages.',
      permissions: requireAuth(),
      raw: true,
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const mode = flow().services.mode;
        const inv = config.inventory;
        return reply.send({
          mode,
          features: {
            quality: inv.qualityEnabled,
            tasks: inv.tasksEnabled,
            dispatch: inv.dispatchEnabled,
            rfid: inv.rfidEnabled,
          },
          valuationMethod: inv.valuationMethod,
        });
      },
    },
  ],
});

export default capabilitiesResource;
