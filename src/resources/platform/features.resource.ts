/**
 * Features Resource — Public endpoint for feature license manifest.
 *
 * GET /api/v1/features — returns enabled modules with tier + capabilities.
 * Public (no auth) — frontend calls on app boot to gate UI.
 *
 * Controlled via ENABLED_FEATURES env var:
 *   ENABLED_FEATURES=core,loyalty:standard,inventory:enterprise,pos
 */

import { defineResource } from '@classytic/arc';
import { allowPublic } from '@classytic/arc/permissions';
import { getFeatureManifest } from '#config/features.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

const featuresResource = defineResource({
  name: 'features',
  displayName: 'Feature License',
  prefix: '/features',
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      permissions: allowPublic(),
      wrapHandler: false,
      summary: 'Get feature license manifest',
      description: 'Returns enabled modules with tier levels and capabilities.',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.send({ success: true, data: getFeatureManifest() });
      },
    },
  ],
});

export default featuresResource;
