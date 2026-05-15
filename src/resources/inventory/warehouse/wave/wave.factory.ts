/**
 * Stock Wave Resource (standard+).
 *
 * Batches move-lines into pick waves with an explicit FSM:
 *   `planned → released → in_progress → completed | cancelled`.
 *
 * Every transition is an atomic `findOneAndUpdate` on the repo with a
 * status guard. Concurrent double-release throws `InvalidTransitionError`.
 *
 * Shape:
 *   - `adapter` for list/get
 *   - `WaveController` overrides `create` → repo.plan (waveNumber generation
 *     stays host-controlled; caller picks the number)
 *   - `disabledRoutes: ['update']` — transitions go through actions
 *   - `actions`: release, start, complete, cancel (Stripe-style FSM)
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import permissions from '#config/permissions.js';
import { allOf } from '#shared/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { requireFlowMode } from '#shared/flow-mode-gate.js';
import { flow, flowCtxFromArcReq } from '../shared/helpers.js';

class WaveController extends BaseController {
  override async create(
    req: IRequestContext,
  ): Promise<IControllerResponse<Record<string, unknown>>> {
    try {
      const ctx = flowCtxFromArcReq(req);
      const body = req.body as {
        waveNumber: string;
        moveLineIds: string[];
        nodeId?: string;
        assignedPickerId?: string;
        priority?: number;
        slaTargetAt?: string;
        strategy?: string;
        plannedBy?: string;
      };
      const wave = await flow().repositories.stockWave.plan(
        {
          waveNumber: body.waveNumber,
          moveLineIds: body.moveLineIds ?? [],
          ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
          ...(body.assignedPickerId !== undefined
            ? { assignedPickerId: body.assignedPickerId }
            : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.slaTargetAt !== undefined
            ? { slaTargetAt: new Date(body.slaTargetAt) }
            : {}),
          ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
          ...(body.plannedBy !== undefined ? { plannedBy: body.plannedBy } : {}),
        },
        ctx,
      );
      return {
        data: wave as unknown as Record<string, unknown>,
        status: 201,
      };
    } catch (error) {
      // arc 2.13 routes thrown errors via its error pipeline; rethrow.
      throw error;
    }
  }
}

export function createStockWaveResource() {
  const engine = flow();

  return defineResource({
    name: 'stock-wave',
    displayName: 'Pick Waves',
    tag: 'Warehouse - Waves',
    prefix: '/inventory/waves',

    adapter: createFlowAdapter(engine.models.StockWave, engine.repositories.stockWave, {
      fieldRules: {
        organizationId: { systemManaged: true },
        status: { systemManaged: true },
        plannedAt: { systemManaged: true },
        releasedAt: { systemManaged: true },
        releasedBy: { systemManaged: true },
        startedAt: { systemManaged: true },
        startedBy: { systemManaged: true },
        completedAt: { systemManaged: true },
        completedBy: { systemManaged: true },
        cancelledAt: { systemManaged: true },
        cancelledBy: { systemManaged: true },
        cancellationReason: { systemManaged: true },
      },
    }),

    controller: new WaveController(engine.repositories.stockWave),
    disabledRoutes: ['update'],

    queryParser: new QueryParser({
      maxLimit: 200,
      allowedFilterFields: [
        'status',
        'nodeId',
        'assignedPickerId',
        'priority',
        'strategy',
        'waveNumber',
      ],
      allowedSortFields: ['plannedAt', 'slaTargetAt', 'priority', 'status'],
    }),
    permissions: {
      list: allOf(requireFlowMode('standard'), permissions.inventory.waveView),
      get: allOf(requireFlowMode('standard'), permissions.inventory.waveView),
      create: allOf(requireFlowMode('standard'), permissions.inventory.waveCreate),
      delete: allOf(requireFlowMode('standard'), permissions.inventory.waveCreate),
    },

    actions: {
      release: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as { releasedBy?: string };
          return flow().repositories.stockWave.release(
            {
              waveId: id,
              ...(body.releasedBy !== undefined ? { releasedBy: body.releasedBy } : {}),
            },
            ctx,
          );
        },
        permissions: allOf(requireFlowMode('standard'), permissions.inventory.waveRelease),
      },
      start: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as { startedBy?: string };
          return flow().repositories.stockWave.start(
            {
              waveId: id,
              ...(body.startedBy !== undefined ? { startedBy: body.startedBy } : {}),
            },
            ctx,
          );
        },
        permissions: allOf(requireFlowMode('standard'), permissions.inventory.waveExecute),
      },
      complete: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as { completedBy?: string };
          return flow().repositories.stockWave.complete(
            {
              waveId: id,
              ...(body.completedBy !== undefined ? { completedBy: body.completedBy } : {}),
            },
            ctx,
          );
        },
        permissions: allOf(requireFlowMode('standard'), permissions.inventory.waveExecute),
      },
      cancel: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as {
            cancellationReason?: string;
            cancelledBy?: string;
          };
          return flow().repositories.stockWave.cancel(
            {
              waveId: id,
              ...(body.cancellationReason !== undefined
                ? { cancellationReason: body.cancellationReason }
                : {}),
              ...(body.cancelledBy !== undefined ? { cancelledBy: body.cancelledBy } : {}),
            },
            ctx,
          );
        },
        permissions: allOf(requireFlowMode('standard'), permissions.inventory.waveCreate),
      },
    },
  });
}
