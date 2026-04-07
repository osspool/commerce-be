/**
 * Member Resource
 *
 * Custom endpoints for Better Auth member records (branch staff).
 * PATCH /api/v1/members/:memberId/status — Activate/deactivate a branch member.
 */

import { defineResource } from '@classytic/arc';
import type { RequestScope } from '@classytic/arc/scope';
import mongoose from 'mongoose';
import { getOrgId } from '@classytic/arc/scope';
import { requireOrgRole } from '@classytic/arc/permissions';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

interface RequestWithScope extends FastifyRequest {
  scope: RequestScope;
}

const updateStatusParams = z.object({
  memberId: z.string().describe('Better Auth member ID'),
});

const updateStatusBody = z.object({
  status: z.enum(['active', 'inactive']).describe('New member status'),
});

function getMemberCollection() {
  return mongoose.connection.getClient().db().collection('member');
}

async function updateMemberStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const req = request as RequestWithScope;
  const { memberId } = req.params as z.infer<typeof updateStatusParams>;
  const { status } = req.body as z.infer<typeof updateStatusBody>;
  const orgId = getOrgId(req.scope);

  if (!orgId) {
    reply.status(400).send({ error: 'Branch context required' });
    return;
  }

  const { ObjectId } = mongoose.Types;

  if (!ObjectId.isValid(memberId)) {
    reply.status(400).send({ error: 'Invalid memberId' });
    return;
  }

  const col = getMemberCollection();
  const member = await col.findOne({
    _id: new ObjectId(memberId),
    organizationId: new ObjectId(orgId),
  });

  if (!member) {
    reply.status(404).send({ error: 'Member not found' });
    return;
  }

  // Prevent self-deactivation
  const user = (req as FastifyRequest & { user?: Record<string, unknown> }).user;
  const currentUserId = (user?.id || user?._id) as string | undefined;
  if (status === 'inactive' && member.userId?.toString() === currentUserId) {
    reply.status(400).send({ error: 'You cannot deactivate yourself' });
    return;
  }

  await col.updateOne({ _id: new ObjectId(memberId) }, { $set: { status } });
  const updated = await col.findOne({ _id: new ObjectId(memberId) });
  reply.send(updated);
}

const memberResource = defineResource({
  name: 'member',
  audit: true,
  displayName: 'Members',
  prefix: '/members',
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'PATCH',
      path: '/:memberId/status',
      handler: updateMemberStatus,
      permissions: requireOrgRole(['branch_manager']),
      wrapHandler: false,
      summary: 'Update member status',
      description: 'Activate or deactivate a branch member.',
      schema: {
        params: updateStatusParams,
        body: updateStatusBody,
      },
    },
  ],
});

export default memberResource;
