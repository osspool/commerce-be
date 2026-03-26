/**
 * Member Resource
 *
 * Custom endpoints for Better Auth member records (branch staff).
 * PATCH /api/v1/members/:memberId/status — Activate/deactivate a branch member.
 */

import { defineResource } from '@classytic/arc';
import mongoose from 'mongoose';
import { getOrgId } from '@classytic/arc/scope';
import { requireOrgRole } from '@classytic/arc/permissions';

function getMemberCollection() {
  return mongoose.connection.getClient().db().collection('member');
}

async function updateMemberStatus(request, reply) {
  const { memberId } = request.params;
  const { status } = request.body;
  const orgId = getOrgId(request.scope);

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
  const currentUserId = request.user?.id;
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
        params: {
          type: 'object',
          properties: { memberId: { type: 'string' } },
          required: ['memberId'],
        },
        body: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['active', 'inactive'] } },
          required: ['status'],
        },
      },
    },
  ],
});

export default memberResource;
