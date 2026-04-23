/**
 * Logistics Service — clean v2.
 *
 * Built on `@classytic/carrier` + `@classytic/carrier-bd` (no
 * `@classytic/bd-logistics` dependency). State lives on the
 * `Fulfillment` record managed by `@classytic/order` — this service is
 * a thin orchestrator between carrier adapters and the order engine.
 *
 * Responsibilities:
 *   1. Map a Fulfillment + Order → CarrierAdapter inputs (BuyLabelInput,
 *      ShipmentInput, TrackingRef).
 *   2. Resolve the right carrier (`fulfillment.trackingInfo.carrier` or
 *      caller override → registry).
 *   3. Persist results back via `repositories.fulfillment.addTracking`
 *      and FSM transitions.
 *   4. Ingest carrier webhooks → normalised event → fulfillment FSM.
 */

import { arcLog } from '@classytic/arc/logger';
import type {
  BuyLabelInput,
  CarrierAdapter,
  Quote,
  ShipmentInput,
  ShipmentLabel,
  TrackingResult,
  TrackingStatusCode,
} from '@classytic/carrier';
import { ProviderValidationError } from '@classytic/carrier-bd';
import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { OperationContext } from '@classytic/primitives/context';

const log = arcLog('logistics');

import platformRepository from '#resources/platform/platform.repository.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import carrierRegistry, { type CarrierCode } from './carrier-registry.js';

export interface LogisticsContext {
  organizationId: string;
  actorRef?: string;
  correlationId?: string;
}

export interface CreateShipmentInput {
  orderNumber: string;
  fulfillmentNumber: string;
  /** Optional carrier override — defaults to `config.logistics.defaultProvider`. */
  carrier?: CarrierCode;
  /** Optional per-shipment carrier metadata (delivery area id, pickup store, etc.). */
  metadata?: Record<string, unknown>;
  /** Override COD amount. Defaults to order grand total when not prepaid. */
  codAmount?: number;
  /** Override shipment weight (grams). Defaults to 500g. */
  weightGrams?: number;
  /** Special-instructions string forwarded to the carrier. */
  instructions?: string;
}

export interface QuoteShipmentInput {
  orderNumber?: string;
  fulfillmentNumber?: string;
  carrier?: CarrierCode;
  destination: ShipmentInput['destination'];
  origin?: ShipmentInput['origin'];
  weightGrams?: number;
  codAmount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Maps the carrier-bd normalised TrackingStatusCode to the Fulfillment
 * FSM verbs used by `@classytic/order`. Returning `null` means "do not
 * transition" — record the event but no FSM move.
 */
const FULFILLMENT_FSM_MAP: Record<TrackingStatusCode, string | null> = {
  label_created: 'picking',
  picked_up: 'packed',
  in_transit: 'shipped',
  out_for_delivery: 'in_transit',
  delivered: 'delivered',
  delivery_attempted: null,
  exception: null,
  returned: null,
  cancelled: 'canceled',
  info: null,
};

function toOpCtx(ctx: LogisticsContext): OperationContext {
  return {
    organizationId: ctx.organizationId,
    actorId: ctx.actorRef ?? 'logistics-service',
    correlationId: ctx.correlationId ?? `logistics-${Date.now()}`,
  };
}

function toOrderCtx(ctx: LogisticsContext): OrderContext {
  return {
    organizationId: ctx.organizationId,
    actorRef: ctx.actorRef ?? 'logistics-service',
    actorKind: 'system',
    correlationId: ctx.correlationId ?? `logistics-${Date.now()}`,
  };
}

class LogisticsService {
  // ── Quote ────────────────────────────────────────────────────────

  /**
   * Get rate quotes from one carrier (or the default). Useful for
   * checkout-time pricing OR admin "what would this cost" UI.
   */
  async quoteShipment(input: QuoteShipmentInput, ctx: LogisticsContext): Promise<Quote[]> {
    const adapter = input.carrier ? carrierRegistry.get(input.carrier) : carrierRegistry.getDefault();

    let destination = input.destination;
    let origin = input.origin;
    const weightGrams = input.weightGrams ?? 500;
    let codAmount = input.codAmount ?? 0;
    let metadata = { ...(input.metadata ?? {}) };

    // Hydrate from order/fulfillment if numbers are supplied.
    if (input.orderNumber || input.fulfillmentNumber) {
      const hydrated = await this._hydrateFromOrder(input.orderNumber, input.fulfillmentNumber, ctx);
      if (hydrated.shipping) destination = hydrated.shipping;
      if (hydrated.origin) origin = origin ?? hydrated.origin;
      if (hydrated.codAmount !== undefined && input.codAmount === undefined) {
        codAmount = hydrated.codAmount;
      }
      metadata = { ...hydrated.metadata, ...metadata };
    }

    if (!origin) {
      // No origin known — use a minimal sentinel; the carrier will use the
      // pickup store from metadata/defaults.
      origin = { line1: 'Warehouse', city: 'Dhaka', country: 'BD' };
    }

    const shipment: ShipmentInput = {
      origin,
      destination,
      packages: [{ weightGrams }],
      codAmount: { amount: codAmount, currency: 'BDT' },
      metadata,
    };
    return adapter.quoteShipment(shipment, toOpCtx(ctx));
  }

  // ── Buy label / create shipment ──────────────────────────────────

  /**
   * Create a carrier shipment for an order's fulfillment. Persists the
   * tracking info on the fulfillment record.
   */
  async createShipment(
    input: CreateShipmentInput,
    ctx: LogisticsContext,
  ): Promise<{
    label: ShipmentLabel;
    fulfillment: unknown;
  }> {
    const engine = await ensureOrderEngine();
    const orderCtx = toOrderCtx(ctx);

    const order = await engine.repositories.order.getByQuery(
      { orderNumber: input.orderNumber },
      repoOptionsFromCtx(orderCtx),
    );
    if (!order) throw new Error(`Order not found: ${input.orderNumber}`);

    const fulfillment = await engine.repositories.fulfillment.getByQuery(
      { fulfillmentNumber: input.fulfillmentNumber },
      repoOptionsFromCtx(orderCtx),
    );
    if (!fulfillment) throw new Error(`Fulfillment not found: ${input.fulfillmentNumber}`);

    const carrierCode = input.carrier ?? (carrierRegistry.getDefault().code as CarrierCode);
    const adapter = carrierRegistry.get(carrierCode);

    const platformConfig = await platformRepository.getConfig();
    const defaults = ((platformConfig as Record<string, unknown>).logistics as Record<string, unknown>) ?? {};

    const f = fulfillment as Record<string, unknown>;
    const shipping = f.shippingAddress as Record<string, unknown> | undefined;
    if (!shipping) throw new Error('Fulfillment has no shippingAddress');

    const totals = (order as Record<string, unknown>).totals as Record<string, unknown> | undefined;
    const grand = totals?.grandTotal as { amount: number } | undefined;
    const paymentState = (order as Record<string, unknown>).paymentState as Record<string, unknown> | undefined;
    const isPrepaid = paymentState?.chargeStatus === 'full';
    const codAmount = input.codAmount ?? (isPrepaid ? 0 : (grand?.amount ?? 0));

    const buy: BuyLabelInput = {
      reference: input.orderNumber,
      origin: this._toContactAddress((order as Record<string, unknown>).origin) ?? {
        line1: 'Warehouse',
        city: 'Dhaka',
        country: 'BD',
      },
      destination: this._toContactAddress(shipping)!,
      packages: [{ weightGrams: input.weightGrams ?? 500 }],
      codAmount: { amount: codAmount, currency: 'BDT' },
      metadata: {
        merchantInvoiceId: input.orderNumber,
        ...(input.instructions ? { deliveryInstructions: input.instructions } : {}),
        // Allow carrier-specific overrides (deliveryAreaId, pickupStoreId,
        // deliveryCityId, deliveryZoneId, etc.) via input.metadata.
        ...((defaults[carrierCode] as Record<string, unknown> | undefined) ?? {}),
        ...(input.metadata ?? {}),
      },
    };

    const label = await adapter.buyLabel(buy, toOpCtx(ctx));

    const updated = await engine.repositories.fulfillment.addTracking(
      input.fulfillmentNumber,
      {
        carrier: adapter.code,
        trackingNumber: label.trackingNumber,
        ...(label.trackingUrl ? { trackingUrl: label.trackingUrl } : {}),
      },
      orderCtx,
    );

    return { label, fulfillment: updated };
  }

  // ── Track ────────────────────────────────────────────────────────

  /**
   * Look up live carrier tracking for a fulfillment (by tracking
   * number) and, if status changed, transition the fulfillment FSM.
   */
  async trackShipment(
    trackingNumber: string,
    ctx: LogisticsContext,
  ): Promise<{
    tracking: TrackingResult;
    fulfillment: unknown;
  }> {
    const engine = await ensureOrderEngine();
    const orderCtx = toOrderCtx(ctx);

    const fulfillment = await engine.repositories.fulfillment.getByQuery(
      { 'trackingInfo.trackingNumber': trackingNumber },
      repoOptionsFromCtx(orderCtx),
    );
    if (!fulfillment) throw new Error('Shipment not found');

    const carrier = ((fulfillment as Record<string, unknown>).trackingInfo as Record<string, unknown> | undefined)
      ?.carrier as string | undefined;
    if (!carrier) throw new Error('Fulfillment has no carrier configured');

    const adapter = carrierRegistry.get(carrier as CarrierCode);
    const tracking = await adapter.track({ trackingNumber }, toOpCtx(ctx));

    let updated = fulfillment;
    const fsmTarget = FULFILLMENT_FSM_MAP[tracking.status];
    const fromStatus = (fulfillment as Record<string, unknown>).status as string;
    if (fsmTarget && fsmTarget !== fromStatus) {
      updated = await engine.repositories.fulfillment.transition(
        (fulfillment as Record<string, unknown>).fulfillmentNumber as string,
        fsmTarget,
        orderCtx,
      );
    }

    return { tracking, fulfillment: updated };
  }

  // ── Cancel ───────────────────────────────────────────────────────

  async cancelShipment(
    trackingNumber: string,
    reason: string,
    ctx: LogisticsContext,
  ): Promise<{ fulfillment: unknown; voided: boolean }> {
    const engine = await ensureOrderEngine();
    const orderCtx = toOrderCtx(ctx);

    const fulfillment = await engine.repositories.fulfillment.getByQuery(
      { 'trackingInfo.trackingNumber': trackingNumber },
      repoOptionsFromCtx(orderCtx),
    );
    if (!fulfillment) throw new Error('Shipment not found');

    const currentStatus = (fulfillment as Record<string, unknown>).status as string;
    if (['delivered', 'returned'].includes(currentStatus)) {
      throw new Error(`Cannot cancel shipment in status: ${currentStatus}`);
    }

    const carrier = ((fulfillment as Record<string, unknown>).trackingInfo as Record<string, unknown> | undefined)
      ?.carrier as string | undefined;
    if (!carrier) throw new Error('Fulfillment has no carrier configured');

    const adapter = carrierRegistry.get(carrier as CarrierCode);
    let voided = false;
    if (adapter.capabilities.voidLabel && typeof adapter.voidLabel === 'function') {
      try {
        await adapter.voidLabel({ trackingNumber }, reason, toOpCtx(ctx));
        voided = true;
      } catch (err) {
        // Carrier rejected — still transition FSM since merchant intent
        // is to cancel. Surface the error message via the response.
        const e = err as Error;
        log.warn('Carrier voidLabel failed:', e.message);
      }
    }

    const updated = await engine.repositories.fulfillment.transition(
      (fulfillment as Record<string, unknown>).fulfillmentNumber as string,
      'canceled',
      orderCtx,
    );
    return { fulfillment: updated, voided };
  }

  // ── Webhook ──────────────────────────────────────────────────────

  /**
   * Ingest a carrier webhook payload.
   *
   * Carriers (RedX, Pathao, Steadfast) do NOT send `x-organization-id` —
   * they call this endpoint directly without any knowledge of our branch
   * model. Tracking numbers are globally unique per carrier, so we:
   *
   *   1. Look the fulfillment up by `trackingInfo.trackingNumber` with NO
   *      org filter (omit `organizationId` from the repo options — the
   *      order engine is configured `multiTenant: false` in be-prod, so
   *      the plugin is off anyway, but we still omit it to make the
   *      intent explicit and to be safe if the engine config ever flips).
   *   2. Derive the correct `organizationId` from the fulfillment doc
   *      itself.
   *   3. Apply the FSM transition + any subsequent writes in THAT
   *      branch's context — never the header's.
   *
   * The `LogisticsContext` passed in is retained only for `actorRef` and
   * `correlationId` (audit trail); its `organizationId` — which may be
   * empty, wrong, or spoofed — is deliberately discarded after lookup.
   */
  async processWebhook(
    carrier: CarrierCode,
    payload: unknown,
    headers: Record<string, string>,
    ctx: LogisticsContext,
  ): Promise<unknown | null> {
    const adapter = carrierRegistry.get(carrier);
    if (typeof adapter.ingestWebhook !== 'function') {
      throw new Error(`Carrier '${carrier}' does not support webhooks`);
    }
    const events = adapter.ingestWebhook(payload, headers);
    if (events.length === 0) return null;

    const engine = await ensureOrderEngine();

    // Lookup options: intentionally WITHOUT `organizationId`. Tracking
    // numbers are carrier-global, so we resolve the branch from the
    // fulfillment document, not the request header.
    const lookupOpts = {
      actorRef: ctx.actorRef ?? 'logistics-webhook',
      actorKind: 'system' as const,
      correlationId: ctx.correlationId ?? `logistics-webhook-${Date.now()}`,
    };

    let lastFulfillment: unknown = null;
    for (const evt of events) {
      const trackingNumber = evt.trackingNumber ?? evt.carrierShipmentId;
      if (!trackingNumber) continue;

      const fulfillment = (await engine.repositories.fulfillment.getByQuery(
        { 'trackingInfo.trackingNumber': trackingNumber },
        lookupOpts as never,
      )) as Record<string, unknown> | null;
      if (!fulfillment) {
        log.warn(`webhook for unknown tracking ${trackingNumber}`);
        continue;
      }

      // Resolve the branch from the fulfillment itself. Better Auth stores
      // `organization._id` as ObjectId — stringify for downstream context.
      const raw = fulfillment.organizationId;
      const resolvedOrgId =
        typeof raw === 'string' ? raw : ((raw as { toString(): string } | undefined)?.toString() ?? '');
      if (!resolvedOrgId) {
        log.warn(`fulfillment ${String(fulfillment.fulfillmentNumber)} has no organizationId`);
        continue;
      }

      const branchCtx: OrderContext = {
        organizationId: resolvedOrgId,
        actorRef: ctx.actorRef ?? 'logistics-webhook',
        actorKind: 'system',
        correlationId: ctx.correlationId ?? `logistics-webhook-${Date.now()}`,
      };

      const code = evt.event?.code;
      const fsmTarget = code ? FULFILLMENT_FSM_MAP[code] : null;
      const fromStatus = fulfillment.status as string;
      if (!fsmTarget || fsmTarget === fromStatus) {
        lastFulfillment = fulfillment;
        continue;
      }

      lastFulfillment = await engine.repositories.fulfillment.transition(
        fulfillment.fulfillmentNumber as string,
        fsmTarget,
        branchCtx,
      );
    }
    return lastFulfillment;
  }

  // ── Internals ───────────────────────────────────────────────────

  private async _hydrateFromOrder(
    orderNumber: string | undefined,
    fulfillmentNumber: string | undefined,
    ctx: LogisticsContext,
  ): Promise<{
    shipping?: ShipmentInput['destination'];
    origin?: ShipmentInput['origin'];
    codAmount?: number;
    metadata: Record<string, unknown>;
  }> {
    const engine = await ensureOrderEngine();
    const orderCtx = toOrderCtx(ctx);
    const out: {
      shipping?: ShipmentInput['destination'];
      origin?: ShipmentInput['origin'];
      codAmount?: number;
      metadata: Record<string, unknown>;
    } = { metadata: {} };

    if (fulfillmentNumber) {
      const f = (await engine.repositories.fulfillment.getByQuery(
        { fulfillmentNumber },
        repoOptionsFromCtx(orderCtx),
      )) as Record<string, unknown> | null;
      if (f) {
        const shipping = this._toContactAddress(f.shippingAddress as Record<string, unknown>);
        if (shipping) out.shipping = shipping;
      }
    }
    if (orderNumber) {
      const o = (await engine.repositories.order.getByQuery({ orderNumber }, repoOptionsFromCtx(orderCtx))) as Record<
        string,
        unknown
      > | null;
      if (o) {
        const totals = o.totals as Record<string, unknown> | undefined;
        const grand = totals?.grandTotal as { amount?: number } | undefined;
        const ps = o.paymentState as Record<string, unknown> | undefined;
        const isPrepaid = ps?.chargeStatus === 'full';
        if (grand?.amount !== undefined) {
          out.codAmount = isPrepaid ? 0 : grand.amount;
        }
      }
    }
    return out;
  }

  private _toContactAddress(raw: unknown): ShipmentInput['destination'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const a = raw as Record<string, unknown>;
    const out: ShipmentInput['destination'] = {
      line1: String(a.line1 ?? ''),
      city: String(a.city ?? ''),
      country: String(a.country ?? 'BD'),
    };
    if (a.name !== undefined) out.name = String(a.name);
    if (a.phone !== undefined) out.phone = String(a.phone);
    if (a.line2 !== undefined) out.line2 = String(a.line2);
    if (a.state !== undefined) out.state = String(a.state);
    if (a.postalCode !== undefined) out.postalCode = String(a.postalCode);
    return out;
  }
}

const logisticsService = new LogisticsService();
export default logisticsService;
export { ProviderValidationError };
