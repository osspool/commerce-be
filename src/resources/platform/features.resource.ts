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
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getFeatureManifest } from '#config/features.js';

const featuresResource = defineResource({
  name: 'features',
  displayName: 'Feature License',
  prefix: '/features',
  disableDefaultRoutes: true,

  routes: [
    {
      method: 'GET',
      path: '/',
      permissions: allowPublic(),
      raw: true,
      summary: 'Get feature license manifest',
      description: 'Returns enabled modules with tier levels and capabilities.',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.send(getFeatureManifest());
      },
    },
  ],
});

export default featuresResource;
