/**
 * Execution Tasks Resource (Enterprise + FLOW_TASKS).
 *
 * Scanner-directed work: queues, next-task assignment, scan intents,
 * completion, and device session lifecycle. Feature-flagged at module
 * level via `config.inventory.tasksEnabled`.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import config from '#config/index.js';
import permissions from '#config/permissions.js';
import { enterpriseModeGuard, flow, flowCtxGuard } from '../shared/helpers.js';

const enterpriseGuards = [enterpriseModeGuard.preHandler, flowCtxGuard.preHandler];

const disabledStub = defineResource({
  name: 'execution-tasks-disabled',
  prefix: '/inventory/tasks',
  disableDefaultRoutes: true,
  routes: [],
});

const taskResource = config.inventory.tasksEnabled
  ? defineResource({
      name: 'execution-tasks',
      displayName: 'Execution Tasks',
      tag: 'Warehouse - Tasks',
      prefix: '/inventory/tasks',
      disableDefaultRoutes: true,
      routeGuards: enterpriseGuards,
      routes: [
        {
          method: 'POST',
          path: '/generate',
          summary: 'Generate tasks from move group',
          description: 'Create one WorkTask per move for scanner-directed execution.',
          permissions: permissions.inventory.taskManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const { moveGroupId } = req.body as { moveGroupId: string };
            const tasks = await svc.generateFromMoveGroup(moveGroupId, ctx);
            return reply.send({ success: true, data: tasks });
          },
        },
        {
          method: 'POST',
          path: '/queues',
          summary: 'Create work queue',
          permissions: permissions.inventory.taskManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const queue = await svc.createQueue(req.body as any, ctx);
            return reply.code(201).send({ success: true, data: queue });
          },
        },
        {
          method: 'POST',
          path: '/next',
          summary: 'Get next task for operator',
          description: 'Get the next available task from a queue and assign to the requesting operator.',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const { queueId, operatorId } = req.body as { queueId: string; operatorId: string };
            const task = await svc.getNextTask(queueId, operatorId, ctx);
            return reply.send({ success: true, data: task });
          },
        },
        {
          method: 'GET',
          path: '/:id/intent',
          summary: 'Get scan intent for task',
          description: 'Returns the next directed scan step for the device (confirm_location, confirm_sku, etc.).',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const intent = await svc.getScanIntent(id, ctx);
            return reply.send({ success: true, data: intent });
          },
        },
        {
          method: 'POST',
          path: '/:id/complete',
          summary: 'Complete task',
          description: 'Mark task as completed. Posts the underlying move via PostingService.',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const task = await svc.completeTask(id, req.body as any, ctx);
            return reply.send({ success: true, data: task });
          },
        },
        {
          method: 'POST',
          path: '/:id/exception',
          summary: 'Report task exception',
          description: 'Flag a task with an exception code (short_pick, damaged, wrong_item, etc.).',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const { exceptionCode, note } = req.body as { exceptionCode: string; note: string };
            const task = await svc.reportException(id, exceptionCode as any, note, ctx);
            return reply.send({ success: true, data: task });
          },
        },
        {
          method: 'POST',
          path: '/sessions/start',
          summary: 'Start device session',
          description: 'Start a scanner/device session for an operator on a queue.',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const { operatorId, queueId, deviceType } = req.body as {
              operatorId: string;
              queueId: string;
              deviceType: string;
            };
            const session = await svc.startSession(operatorId, queueId, deviceType as any, ctx);
            return reply.code(201).send({ success: true, data: session });
          },
        },
        {
          method: 'POST',
          path: '/sessions/:id/end',
          summary: 'End device session',
          permissions: permissions.inventory.taskExecute,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.task;
            if (!svc) return reply.code(503).send({ success: false, error: 'Task service not available' });
            const session = await svc.endSession(id, ctx);
            return reply.send({ success: true, data: session });
          },
        },
      ],
    })
  : disabledStub;

export default taskResource;
