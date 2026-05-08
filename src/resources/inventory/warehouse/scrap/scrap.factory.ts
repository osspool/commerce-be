/**
 * Scrap (write-off) Resource (standard+).
 *
 * Approach B: adapter for read CRUD (list/get) + custom controller `create()`
 * that delegates to `flow().services.scrap.create()` for invariant enforcement
 * (mode gate, validation, sequence number, status derivation, domain events) +
 * `actions:` block for the FSM verbs (cancel, execute) plus the unified
 * approval chain preset (`submit_for_approval` + `decide`).
 *
 * `update` is intentionally disabled — scraps mutate only via FSM transitions.
 *
 * Approval gate is contributed by the shared `withApprovalChain` preset
 * (`#core/approval`). Replaces the hand-rolled `approve` / `reject` actions
 * we used to keep here. The kernel scrap service still owns event emission
 * and post-decision side effects — `onApproved` / `onRejected` flip the
 * coarse `status` field and emit `flow.scrap.approved` / `flow.scrap.rejected`
 * via `engine.services.eventLog`, mirroring what the kernel `approve()` /
 * `reject()` did before. Note: the kernel service `approve(id, decision, ctx)`
 * applies the decision itself and would re-apply it after the preset has
 * already advanced the chain (STEP_NOT_ACTIVE), so calling it from the hook
 * is not viable — the hook does the same status flip + event emission
 * directly.
 *
 * Registered MANUALLY by the inventory-management plugin after Flow init —
 * the adapter needs the engine's model/repo at registration time.
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { CreateScrapInput } from '@classytic/flow';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import {
  withApprovalChain,
  type ApprovableDoc,
} from '#core/approval/with-approval-chain.js';
import type { Repository } from '@classytic/mongokit';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { flow, flowCtxFromArcReq, standardModeGuard } from '../shared/helpers.js';

/**
 * Local typed view of a StockScrap document. Extends `ApprovableDoc` so the
 * preset reads `doc.approvals` natively (P7 — flow's StockScrap schema).
 */
interface ScrapDoc extends ApprovableDoc {
  organizationId?: string;
  scrapNumber?: string;
  status: string;
  skuRef?: string;
  reason?: string;
}

/**
 * ScrapController — overrides `create` so the auto-generated `POST /` route
 * goes through `ScrapService.create()` (which gates mode, validates invariants,
 * generates `SCR-NNNN`, derives initial status, emits `ScrapDrafted`).
 *
 * `list` / `get` / `delete` inherit from BaseController and read straight
 * from the repo (which is fine — they're queries with no domain logic).
 */
class ScrapController extends BaseController {
  async create(req: IRequestContext): Promise<IControllerResponse<Record<string, unknown>>> {
    const ctx = flowCtxFromArcReq(req);
    const result = await flow().services.scrap.create(req.body as CreateScrapInput, ctx);
    return { data: result as unknown as Record<string, unknown>, status: 201 };
  }
}

export function createScrapResource() {
  const engine = flow();

  return defineResource({
    name: 'scrap',
    displayName: 'Inventory Write-offs',
    tag: 'Warehouse - Scrap',
    prefix: '/inventory/scrap',

    // Adapter wires list/get/delete + body-schema generation. `update` is
    // disabled below — scraps move only via FSM verbs in `actions:`.
    adapter: createFlowAdapter(engine.models.StockScrap, engine.repositories.stockScrap, {
      // Server-managed lifecycle fields. Arc must NOT require them in the
      // create body (the service assigns scrapNumber + the FSM fields fill
      // in over time as approve/execute fires).
      fieldRules: {
        organizationId: { systemManaged: true },
        scrapNumber: { systemManaged: true },
        status: { systemManaged: true },
        // Mutated only via submit_for_approval / decide actions; never via PATCH.
        approvals: { systemManaged: true },
        moveId: { systemManaged: true },
        moveGroupId: { systemManaged: true },
        executedAt: { systemManaged: true },
        executedBy: { systemManaged: true },
        rejectedAt: { systemManaged: true },
        rejectedBy: { systemManaged: true },
        rejectionReason: { systemManaged: true },
        cancelledAt: { systemManaged: true },
        cancelledBy: { systemManaged: true },
        createdBy: { systemManaged: true },
      },
    }),

    // Arc 2.10.6 dropped the index signature on `ControllerLike`, so class
    // instances satisfy the type directly — no more `as unknown as` cast.
    controller: new ScrapController(engine.repositories.stockScrap),
    disabledRoutes: ['update'],

    queryParser: new QueryParser({
      maxLimit: 200,
      allowedFilterFields: ['status', 'skuRef', 'locationId', 'reason'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.scrapView,
      get: permissions.inventory.scrapView,
      create: permissions.inventory.scrapCreate,
      update: permissions.inventory.scrapApprove, // ignored (route disabled) but kept for type
      delete: permissions.inventory.scrapApprove,
    },

    actions: {
      cancel: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.cancel(id, (data as { reason?: string }).reason, ctx);
        },
        permissions: permissions.inventory.scrapApprove,
      },
      execute: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.execute(id, ctx);
        },
        permissions: permissions.inventory.scrapApprove,
      },
      // Approval gate — `submit_for_approval` + `decide` come from the
      // shared `withApprovalChain` preset. Replaces the hand-rolled `approve`
      // / `reject` per-action handlers. The kernel scrap service's own
      // `approve()` advances the chain itself (calls `applyDecision`) and
      // would clash with the preset which has already advanced it — so we
      // do not call it from the hook. Instead, the hook updates the doc's
      // coarse status field and emits the matching `flow.scrap.*` event so
      // downstream subscribers (shrinkage dashboards, replenishment) keep
      // working as before. `execute()` reads `status === 'approved'` so the
      // gate stays end-to-end.
      ...withApprovalChain<ScrapDoc>({
        subjectType: 'stock_scrap',
        repository: engine.repositories.stockScrap as unknown as Repository<ScrapDoc>,
        // Allow re-submitting after a rejected chain. Status `rejected` is a
        // chain-level outcome — the doc itself is terminal and a fresh chain
        // can't recover it; the preset's `existingChain.status` check does
        // the real gate. We list `draft` and `pending_approval` here so a
        // first submission and a partial re-submission (after a chain was
        // attached but the doc fell back to draft on retry) are accepted.
        allowedSubmitStatus: ['draft', 'pending_approval'],
        // `status` is the default — preset reads `doc.status` natively.
        permissions: {
          submit: permissions.inventory.scrapApprove,
          decide: permissions.inventory.scrapApprove,
        },
        toEvaluationContext: (doc) => ({
          branchId: String(doc.organizationId ?? ''),
          ...(doc.skuRef ? { skuRef: doc.skuRef } : {}),
          ...(doc.reason ? { reason: doc.reason } : {}),
        }),
        resolveChain: createPolicyChainResolver(),
        // After the chain is attached, mirror the kernel's `deriveInitialStatus`
        // logic: a non-approved chain flips the doc to `pending_approval` so
        // dashboards reflect the in-flight workflow. Idempotent — already-
        // pending docs stay pending.
        onSubmitted: async (doc, ctx) => {
          const updated = (await (
            engine.models.StockScrap as unknown as {
              findOneAndUpdate: (q: unknown, u: unknown, o: unknown) => { lean: () => Promise<unknown> };
            }
          )
            .findOneAndUpdate(
              { _id: doc._id, organizationId: ctx.organizationId },
              { $set: { status: 'pending_approval' } },
              { returnDocument: 'after' },
            )
            .lean()) as ScrapDoc | null;
          return updated ?? undefined;
        },
        // Chain approved → flip doc status to `approved`, emit ScrapApproved.
        // Equivalent to the kernel's `approve()` Path 2 final branch, minus
        // the chain re-application (the preset already did that).
        onApproved: async (doc, ctx) => {
          const updated = (await (
            engine.models.StockScrap as unknown as {
              findOneAndUpdate: (q: unknown, u: unknown, o: unknown) => { lean: () => Promise<unknown> };
            }
          )
            .findOneAndUpdate(
              { _id: doc._id, organizationId: ctx.organizationId },
              { $set: { status: 'approved' } },
              { returnDocument: 'after' },
            )
            .lean()) as ScrapDoc | null;
          if (!updated) return undefined;
          await engine.services.eventLog.emit('flow.scrap.approved', {
            organizationId: ctx.organizationId,
            scrapId: String(doc._id),
            scrapNumber: updated.scrapNumber ?? '',
            ...(ctx.actorId ? { approvedBy: ctx.actorId } : {}),
            approvedAt: new Date().toISOString(),
          });
          return updated;
        },
        // Chain rejected → flip doc status to `rejected`, capture rejection
        // metadata, emit ScrapRejected.
        onRejected: async (doc, decision, ctx) => {
          const rejectedAt = new Date();
          const updated = (await (
            engine.models.StockScrap as unknown as {
              findOneAndUpdate: (q: unknown, u: unknown, o: unknown) => { lean: () => Promise<unknown> };
            }
          )
            .findOneAndUpdate(
              { _id: doc._id, organizationId: ctx.organizationId },
              {
                $set: {
                  status: 'rejected',
                  rejectedBy: ctx.actorId ?? null,
                  rejectedAt,
                  rejectionReason: decision.note ?? '',
                },
              },
              { returnDocument: 'after' },
            )
            .lean()) as ScrapDoc | null;
          if (!updated) return undefined;
          await engine.services.eventLog.emit('flow.scrap.rejected', {
            organizationId: ctx.organizationId,
            scrapId: String(doc._id),
            scrapNumber: updated.scrapNumber ?? '',
            ...(ctx.actorId ? { rejectedBy: ctx.actorId } : {}),
            rejectedAt: rejectedAt.toISOString(),
            ...(decision.note !== undefined ? { reason: decision.note } : {}),
          });
          return updated;
        },
      }),
    },
  });
}
