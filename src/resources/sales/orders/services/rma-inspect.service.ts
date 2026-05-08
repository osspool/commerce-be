/**
 * RMA Inspection Service
 *
 * Finalizes a confirmed-with-inspection RMA: moves goods out of
 * RETURN_HOLDING per per-action disposition AND publishes the same
 * accounting events the confirm path would have published if inspection
 * was disabled. So the GL pipeline downstream is unchanged — only the
 * timing differs.
 *
 * Flow:
 *   confirm (requireInspection=true) →  goods → HOLDING, ledger DEFERRED
 *   inspect {actions:[{actionId, disposition}]}  ← THIS SERVICE
 *     - validates change is confirmed AND inspectionStatus === 'pending'
 *     - moves HOLDING → DEFAULT (restock) or HOLDING → ADJUSTMENT (write-off)
 *     - publishes accounting:return.restocked  for restock leg
 *     - publishes accounting:inventory.adjusted (loss) for write-off leg
 *     - stamps metadata.inspectedAt + inspectionStatus + final dispositions
 *     - idempotent via metadata.inspectedAt presence
 *
 * Idempotency keys preserve the existing scheme (orderId:changeNumber for
 * the restock JE, orderId:changeNumber:writeoff for the loss JE) so a
 * deferred-then-inspect flow produces the SAME journal entries as the
 * non-deferred confirm flow — auditors see identical postings whether or
 * not QC was used.
 */

import type { FlowEngine } from '@classytic/flow';
import { publish } from '#lib/events/arcEvents.js';
import {
  ADJUSTMENT_LOCATION,
  buildFlowContext,
  DEFAULT_LOCATION,
  RETURN_HOLDING_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngine } from '#resources/inventory/flow/flow-engine.js';
import { publishRmaLedger } from '../lifecycle/handlers/_rma-ledger.js';
import { type Disposition, isWriteOffValue, type OrderChangeMetadata } from '../lifecycle/handlers/_shared.js';
import { ensureOrderEngine } from '../order.engine.js';

/**
 * Re-exported alias for back-compat — the action-handler imports
 * `InspectionDisposition`. Internally we use the canonical `Disposition`
 * type from `_shared.ts` so all RMA paths share one vocabulary.
 */
export type InspectionDisposition = Disposition;

export interface InspectInput {
  changeNumber: string;
  /** Per-action disposition list — order-aligned with `actions[]` from the change. */
  dispositions: InspectionDisposition[];
  notes?: string;
}

export interface InspectResult {
  changeNumber: string;
  movedFromHolding: number;
  restockUnits: number;
  writeOffUnits: number;
  cogsReversedAmount: number;
  writeOffAmount: number;
  inspectionStatus: 'passed' | 'mixed' | 'failed';
}

interface OrderChangeAction {
  actionId?: string;
  type?: string;
  orderLineId?: string;
  quantity?: number;
}
interface OrderLineLite {
  lineId?: string;
  snapshot?: { sku?: string; productId?: string; offerId?: string; costPrice?: number };
  offerId?: string;
}

/**
 * Aggregate inspection-status from per-action dispositions:
 * all-restock → passed, all-writeoff → failed, mix → mixed.
 * Uses the canonical `isWriteOffValue` from `_shared.ts` so behavior
 * stays in lock-step with the immediate-confirm path.
 */
function aggregateStatus(d: InspectionDisposition[]): 'passed' | 'mixed' | 'failed' {
  const writeOffs = d.filter((x) => isWriteOffValue(x)).length;
  if (writeOffs === 0) return 'passed';
  if (writeOffs === d.length) return 'failed';
  return 'mixed';
}

export async function inspectChange(
  input: InspectInput,
  ctx: { actorRef: string; organizationId: string },
): Promise<InspectResult> {
  const engine = await ensureOrderEngine();
  const change = (await engine.repositories.orderChange.getByQuery(
    { changeNumber: input.changeNumber },
    { throwOnNotFound: false } as never,
  )) as Record<string, unknown> | null;
  if (!change) throw Object.assign(new Error('Change not found'), { statusCode: 404 });
  if (change.status !== 'confirmed') {
    throw Object.assign(new Error(`Change must be confirmed (got: ${change.status})`), { statusCode: 422 });
  }
  const meta = (change.metadata as OrderChangeMetadata | undefined) ?? {};
  if (meta.requireInspection !== true) {
    throw Object.assign(
      new Error('Change does not require inspection — confirm already finalized goods + ledger'),
      { statusCode: 422 },
    );
  }
  if (meta.inspectedAt) {
    throw Object.assign(new Error('Change already inspected'), { statusCode: 422 });
  }
  if (meta.inspectionStatus !== 'pending') {
    throw Object.assign(
      new Error(`Inspection status is ${meta.inspectionStatus} — expected 'pending'`),
      { statusCode: 422 },
    );
  }

  const actions = (change.actions as OrderChangeAction[] | undefined) ?? [];
  const returnActions = actions
    .map((a, i) => ({ action: a, index: i }))
    .filter(({ action }) => action.type === 'return_item' && action.orderLineId && (action.quantity ?? 0) > 0);
  if (returnActions.length === 0) {
    throw Object.assign(new Error('No return-item actions on change'), { statusCode: 422 });
  }
  if (input.dispositions.length !== returnActions.length) {
    throw Object.assign(
      new Error(
        `dispositions length ${input.dispositions.length} != return-item actions length ${returnActions.length}`,
      ),
      { statusCode: 400 },
    );
  }

  // Resolve order + line snapshots (cost basis for ledger).
  const order = (await engine.repositories.order.getByQuery(
    { orderNumber: change.orderNumber },
    { throwOnNotFound: false } as never,
  )) as Record<string, unknown> | null;
  if (!order || !order._id) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

  const orderLines = (order.lines as OrderLineLite[] | undefined) ?? [];
  const lineByLineId = new Map<string, OrderLineLite>();
  for (const line of orderLines) {
    if (line.lineId) lineByLineId.set(line.lineId, line);
  }

  // Stock side: walk actions, build move items HOLDING → DEFAULT/ADJUSTMENT.
  // Cost-side resolution + accounting events are delegated to `publishRmaLedger`
  // (the same helper the immediate-confirm path uses) — DRY guarantees the
  // GL pipeline is identical regardless of QC mode.
  const isWriteOffAt = (i: number): boolean => isWriteOffValue(input.dispositions[i]);

  let restockUnits = 0;
  let writeOffUnits = 0;
  interface MoveItem {
    moveGroupId: string;
    operationType: 'transfer';
    skuRef: string;
    sourceLocationId: string;
    destinationLocationId: string;
    quantityPlanned: number;
  }
  const items: MoveItem[] = [];

  for (let i = 0; i < returnActions.length; i++) {
    const { action } = returnActions[i];
    const line = lineByLineId.get(action.orderLineId as string);
    if (!line) continue;
    const qty = action.quantity as number;
    const skuRef = line.snapshot?.sku;
    if (!skuRef) continue;
    const writeOff = isWriteOffAt(i);
    items.push({
      moveGroupId: '',
      operationType: 'transfer',
      skuRef,
      sourceLocationId: RETURN_HOLDING_LOCATION,
      destinationLocationId: writeOff ? ADJUSTMENT_LOCATION : DEFAULT_LOCATION,
      quantityPlanned: qty,
    });
    if (writeOff) writeOffUnits += qty;
    else restockUnits += qty;
  }

  // Move stock per disposition (HOLDING → DEFAULT / ADJUSTMENT).
  if (items.length > 0) {
    const flow: FlowEngine = getFlowEngine();
    const flowCtx = buildFlowContext(ctx.organizationId, 'lifecycle.inspect');
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'transfer',
        metadata: {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          changeNumber: input.changeNumber,
          source: 'lifecycle.inspect',
          dispositions: input.dispositions,
        },
        items,
      },
      flowCtx,
    );
    await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
    await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);
  }

  // Ledger — same idempotency keys as the non-deferred path so audit trail
  // is identical regardless of whether inspection was used.
  const ledgerResult = await publishRmaLedger({
    changeNumber: input.changeNumber,
    orderId: String(order._id),
    branchId: ctx.organizationId,
    reasonText: `RMA ${input.changeNumber} (inspected): ${String(change.reason ?? '')}`.slice(0, 200),
    returnActions,
    orderLines,
    isWriteOffAt,
    publish,
  });
  const { cogsReversedAmount: cogsReversed, writeOffAmount: writeOffCost } = ledgerResult;

  const status = aggregateStatus(input.dispositions);

  await engine.models.OrderChange.updateOne(
    { changeNumber: input.changeNumber },
    {
      $set: {
        'metadata.inspectedAt': new Date(),
        'metadata.inspectedBy': ctx.actorRef,
        'metadata.inspectionStatus': status,
        'metadata.inspectionNotes': input.notes,
        'metadata.dispositions': input.dispositions,
        'metadata.cogsReversedAt': new Date(),
        'metadata.cogsReversedAmount': cogsReversed,
        'metadata.writeOffAmount': writeOffCost,
      },
    },
  );

  return {
    changeNumber: input.changeNumber,
    movedFromHolding: restockUnits + writeOffUnits,
    restockUnits,
    writeOffUnits,
    cogsReversedAmount: cogsReversed,
    writeOffAmount: writeOffCost,
    inspectionStatus: status,
  };
}
