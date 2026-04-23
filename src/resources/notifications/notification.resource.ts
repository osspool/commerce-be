/**
 * Notification Resource Definition
 *
 * In-app notifications with SSE real-time delivery.
 * Service pattern: disableDefaultRoutes + custom endpoints.
 * All endpoints are user-scoped (current user only).
 */

import type { ArcRequest } from '@classytic/arc';
import { defineResource } from '@classytic/arc';
import type { FastifyInstance, FastifyReply } from 'fastify';
import permissions from '#config/permissions.js';
import { events } from './events.js';
import notificationRepository from './notification.repository.js';
import { listQuerySchema, markReadParamsSchema } from './notification.schemas.js';

function getUserScope(req: ArcRequest): { userId: string; organizationId: string } {
  const userId = req.user?.id as string;
  const organizationId =
    (req.scope as { organizationId?: string })?.organizationId || (req.headers['x-organization-id'] as string);
  return { userId, organizationId: String(organizationId) };
}

export default defineResource({
  name: 'notification',
  displayName: 'Notifications',
  tag: 'Notifications',
  prefix: '/notifications',
  disableDefaultRoutes: true,

  permissions: {
    list: permissions.notifications.view,
    get: permissions.notifications.view,
  },

  routes: [
    // ── GET / — List notifications for current user ──
    {
      method: 'GET',
      path: '/',
      summary: 'List my notifications',
      permissions: permissions.notifications.view,
      raw: true,
      schema: { querystring: listQuerySchema },
      handler: async (req: ArcRequest, reply: FastifyReply) => {
        const { userId, organizationId } = getUserScope(req);
        const query = req.query as { page?: number; limit?: number; unreadOnly?: boolean; type?: string };
        const result = await notificationRepository.listForUser(organizationId, userId, query);
        return reply.send({ success: true, data: result.data, pagination: result.pagination });
      },
    },

    // ── GET /unread-count — Badge count ──
    {
      method: 'GET',
      path: '/unread-count',
      summary: 'Get unread notification count',
      permissions: permissions.notifications.view,
      raw: true,
      handler: async (req: ArcRequest, reply: FastifyReply) => {
        const { userId, organizationId } = getUserScope(req);
        const count = await notificationRepository.countUnread(organizationId, userId);
        return reply.send({ success: true, data: { count } });
      },
    },

    // ── PATCH /:id/read — Mark single notification as read ──
    {
      method: 'PATCH',
      path: '/:id/read',
      summary: 'Mark notification as read',
      permissions: permissions.notifications.view,
      raw: true,
      schema: { params: markReadParamsSchema },
      handler: async (req: ArcRequest, reply: FastifyReply) => {
        const { userId, organizationId } = getUserScope(req);
        const { id } = req.params as { id: string };
        const doc = await notificationRepository.markRead(organizationId, userId, id);
        if (!doc) return reply.status(404).send({ success: false, error: 'Notification not found' });
        return reply.send({ success: true, data: doc });
      },
    },

    // ── PATCH /read-all — Mark all notifications as read ──
    {
      method: 'PATCH',
      path: '/read-all',
      summary: 'Mark all notifications as read',
      permissions: permissions.notifications.view,
      raw: true,
      handler: async (req: ArcRequest, reply: FastifyReply) => {
        const { userId, organizationId } = getUserScope(req);
        const modifiedCount = await notificationRepository.markAllRead(organizationId, userId);
        return reply.send({ success: true, data: { modifiedCount } });
      },
    },

    // ── GET /stream — SSE real-time notifications ──
    {
      method: 'GET',
      path: '/stream',
      summary: 'SSE notification stream',
      permissions: permissions.notifications.stream,
      raw: true,
      // preAuth promotes query params to headers before Arc's auth runs.
      // EventSource API cannot set custom headers — query params are the standard SSE auth pattern.
      preAuth: [
        async (req: ArcRequest) => {
          const query = req.query as Record<string, string>;
          if (!req.headers.authorization && query?.token) {
            req.headers.authorization = `Bearer ${query.token}`;
          }
          if (!req.headers['x-organization-id'] && query?.orgId) {
            req.headers['x-organization-id'] = query.orgId;
          }
        },
      ],
      handler: async (req: ArcRequest, reply: FastifyReply) => {
        const { userId, organizationId } = getUserScope(req);

        // Hijack the response so Fastify doesn't auto-send.
        // @fastify/cors already set CORS headers via onRequest hook — getHeaders() captures them.
        reply.hijack();
        const corsHeaders = reply.getHeaders();
        reply.raw.writeHead(200, {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        } as any);
        reply.raw.flushHeaders();

        // Initial connection event
        reply.raw.write(`event: connected\ndata: ${JSON.stringify({ status: 'ok' })}\n\n`);

        // Register with SSE manager
        const fastify = req.server as FastifyInstance;
        if (fastify.sseManager) {
          fastify.sseManager.addConnection(userId, organizationId, reply.raw);
        }

        // Keep connection open — do NOT call reply.send()
        // Connection cleanup handled by SSEManager on 'close' event
      },
    },
  ],

  events,
});
