import { defineResource } from '@classytic/arc';
import { requireRoles } from '@classytic/arc/permissions';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';

// Module -> resource name mapping for frontend filtering
const MODULE_RESOURCES: Record<string, string[]> = {
  inventory: ['transfer', 'purchase', 'supplier', 'stock-request'],
  accounting: ['account', 'journal-entry', 'fiscal-period', 'budget'],
  sales: ['order', 'customer', 'transaction'],
  commerce: ['branch', 'member', 'user'],
};

interface AuditQuerystring {
  resource?: string;
  documentId?: string;
  userId?: string;
  organizationId?: string;
  action?: string;
  module?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

export default defineResource({
  name: 'audit-log',
  displayName: 'Audit Logs',
  tag: 'Audit',
  prefix: '/audit-logs',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'Query audit logs (superadmin only)',
      permissions: requireRoles(['superadmin']),
      raw: true,
      handler: (async (req: FastifyRequest<{ Querystring: AuditQuerystring }>, reply: FastifyReply) => {
        const q = req.query;

        // Resolve module filter to resource names
        if (q.module && MODULE_RESOURCES[q.module]) {
          const resources = MODULE_RESOURCES[q.module];
          const limit = q.limit ? parseInt(q.limit, 10) : 50;
          const offset = q.offset ? parseInt(q.offset, 10) : 0;

          // Query all resources in the module and merge
          const allEntries = [];
          for (const res of resources) {
            const entries = await req.server.audit.query({
              resource: res,
              documentId: q.documentId,
              userId: q.userId,
              organizationId: q.organizationId,
              action: q.action
                ? q.action.includes(',')
                  ? (q.action.split(',') as any)
                  : (q.action as any)
                : undefined,
              from: q.from ? new Date(q.from) : undefined,
              to: q.to ? new Date(q.to) : undefined,
              limit: limit * 2, // over-fetch then trim after merge
              offset: 0,
            });
            allEntries.push(...entries);
          }

          // Sort by timestamp desc and paginate
          allEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          const paginated = allEntries.slice(offset, offset + limit);

          return reply.send({ success: true, data: paginated, total: allEntries.length });
        }

        // Direct query (no module filter)
        const entries = await req.server.audit.query({
          resource: q.resource,
          documentId: q.documentId,
          userId: q.userId,
          organizationId: q.organizationId,
          action: q.action ? (q.action.includes(',') ? (q.action.split(',') as any) : (q.action as any)) : undefined,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
          limit: q.limit ? parseInt(q.limit, 10) : 50,
          offset: q.offset ? parseInt(q.offset, 10) : 0,
        });

        return reply.send({ success: true, data: entries });
      }) as any,
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get single audit log entry',
      permissions: requireRoles(['superadmin']),
      raw: true,
      handler: (async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const db = mongoose.connection.db;
        if (!db) return reply.code(500).send({ success: false, error: 'Database not available' });

        const doc = await db.collection('audit_logs').findOne({ id: req.params.id });
        if (!doc) return reply.code(404).send({ success: false, error: 'Audit entry not found' });

        return reply.send({ success: true, data: doc });
      }) as any,
    },
  ],
});
