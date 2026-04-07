/**
 * Notification Plugin
 *
 * Registers the notification resource (always on — no feature gate).
 */

import type { FastifyPluginAsync } from 'fastify';
import notificationResource from './notification.resource.js';

export default notificationResource.toPlugin() as FastifyPluginAsync;
