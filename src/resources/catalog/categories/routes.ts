/**
 * Category Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: ~50 lines
 * AFTER: 13 lines
 * REDUCTION: 74%
 */

import type { FastifyPluginAsync } from 'fastify';
import categoryResource from './category.resource.js';

export default categoryResource.toPlugin() as FastifyPluginAsync;
