/**
 * Logistics Controller — clean v2.
 *
 * Built on `@classytic/carrier-bd` + `@classytic/bd-areas` (no legacy
 * `@classytic/bd-logistics`). HTTP handlers map request → service →
 * response. All real work lives in the service / adapter / registry.
 */

import bdAreas, { searchAreas as bdSearchAreas, getAreasByPostCode } from '@classytic/bd-areas';
import {
  findCity,
  findZone,
  getZonesByCity,
  PATHAO_CITIES,
  searchZones as searchPathaoZones,
} from '@classytic/bd-areas/pathao';
import { buildPathaoBulkCsv, defaultPathaoCsvFilename, type PathaoCsvRow } from '@classytic/carrier-bd';
import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import config from '../../config/index.js';
import PlatformConfig from '#resources/platform/platform.model.js';
import carrierRegistry from './services/carrier-registry.js';
import logisticsService, { type LogisticsContext } from './services/logistics.service.js';
import { computeEstimate } from './utils/resolve-zone.js';
import { DELIVERY_ZONES } from './utils/zones.js';

function getCtx(req: FastifyRequest): LogisticsContext {
  const user = (req as unknown as { user?: { _id?: string; id?: string } }).user;
  return {
    organizationId: (req.headers['x-organization-id'] as string) ?? '',
    actorRef: user?._id ?? user?.id ?? 'logistics-anonymous',
    correlationId: req.id ?? `logistics-${Date.now()}`,
  };
}

function fail(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ success: false, message });
}

class LogisticsController {
  // bind for raw fastify routes
  constructor() {
    for (const k of Object.getOwnPropertyNames(LogisticsController.prototype)) {
      if (k === 'constructor') continue;
      const fn = (this as Record<string, unknown>)[k];
      if (typeof fn === 'function') (this as Record<string, unknown>)[k] = fn.bind(this);
    }
  }

  // ── Config + health ───────────────────────────────────────────────

  async getConfig(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send({
      success: true,
      data: {
        defaultProvider: config.logistics.defaultProvider,
        configured: carrierRegistry.configured(),
        capabilities: Object.fromEntries(
          carrierRegistry.configured().map((code) => [code, carrierRegistry.get(code).capabilities]),
        ),
        note: 'Configuration is managed via .env file. Restart server after changes.',
      },
    });
  }

  // ── Areas (legacy unified bd-areas — kept for RedX flows) ─────────

  async getDivisions(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send({ success: true, data: bdAreas.getDivisions() });
  }

  async getDistricts(req: FastifyRequest<{ Params: { division: string } }>, reply: FastifyReply) {
    const districts = bdAreas.getDistrictsByDivision(req.params.division);
    if (!districts.length) return fail(reply, 404, `Division '${req.params.division}' not found`);
    return reply.send({ success: true, data: districts });
  }

  async getAreas(req: FastifyRequest<{ Querystring: { zoneId?: string; district?: string } }>, reply: FastifyReply) {
    const { zoneId, district } = req.query;
    let areas = bdAreas.getAllAreas();
    if (zoneId) areas = areas.filter((a) => a.zoneId === parseInt(zoneId, 10));
    if (district) areas = areas.filter((a) => a.districtId === district);
    return reply.send({ success: true, data: areas });
  }

  async searchAreas(req: FastifyRequest<{ Querystring: { q: string; limit?: string } }>, reply: FastifyReply) {
    const { q, limit } = req.query;
    if (!q || q.length < 2) return fail(reply, 400, 'Search query must be at least 2 characters');
    const areas = bdSearchAreas(q, parseInt(limit as string, 10) || 20);
    return reply.send({ success: true, data: areas });
  }

  async getAreasByPostCode(req: FastifyRequest<{ Querystring: { postCode: string } }>, reply: FastifyReply) {
    const code = Number(req.query.postCode);
    if (!Number.isFinite(code)) return fail(reply, 400, 'postCode must be numeric');
    return reply.send({ success: true, data: getAreasByPostCode(code) });
  }

  async getDeliveryZones(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send({ success: true, data: DELIVERY_ZONES });
  }

  async estimateCharge(
    req: FastifyRequest<{ Querystring: { areaId?: string; deliveryAreaId?: string; amount?: string } }>,
    reply: FastifyReply,
  ) {
    const rawAreaId = req.query.areaId ?? req.query.deliveryAreaId;
    if (!rawAreaId) return fail(reply, 400, 'areaId is required');
    const areaIdNum = parseInt(rawAreaId, 10);
    if (!Number.isFinite(areaIdNum)) return fail(reply, 400, 'areaId must be numeric');

    const area = bdAreas.getArea(areaIdNum);
    if (!area) return fail(reply, 404, 'Area not found');

    const amountNum = parseFloat(req.query.amount ?? '0') || 0;
    const cfg = await (PlatformConfig as unknown as { getConfig: () => Promise<any> }).getConfig();
    const checkout = cfg?.checkout?.toObject ? cfg.checkout.toObject() : cfg?.checkout ?? {};
    const estimate = computeEstimate(area, amountNum, checkout);

    return reply.send({ success: true, data: { area, ...estimate } });
  }

  // ── Pathao taxonomy (NEW — backed by @classytic/bd-areas/pathao) ──

  async getPathaoCities(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send({ success: true, data: PATHAO_CITIES });
  }

  async getPathaoZones(req: FastifyRequest<{ Params: { cityId: string } }>, reply: FastifyReply) {
    const cityId = Number(req.params.cityId);
    if (!Number.isFinite(cityId)) return fail(reply, 400, 'cityId must be numeric');
    const city = findCity(cityId);
    if (!city) return fail(reply, 404, `Pathao city ${cityId} not found`);
    return reply.send({ success: true, data: { city, zones: getZonesByCity(cityId) } });
  }

  async searchPathaoZones(req: FastifyRequest<{ Querystring: { q: string; limit?: string } }>, reply: FastifyReply) {
    const { q, limit } = req.query;
    if (!q || q.length < 2) return fail(reply, 400, 'Search query must be at least 2 characters');
    const results = searchPathaoZones(q, parseInt(limit as string, 10) || 20);
    return reply.send({ success: true, data: results });
  }

  // ── Quote ─────────────────────────────────────────────────────────

  async quoteShipment(
    req: FastifyRequest<{
      Body: {
        carrier?: 'redx' | 'pathao' | 'steadfast';
        orderNumber?: string;
        fulfillmentNumber?: string;
        destination?: Record<string, unknown>;
        weightGrams?: number;
        codAmount?: number;
        metadata?: Record<string, unknown>;
      };
    }>,
    reply: FastifyReply,
  ) {
    const body = req.body ?? {};
    if (!body.destination && !body.fulfillmentNumber) {
      return fail(reply, 400, 'destination or fulfillmentNumber required');
    }
    try {
      const quotes = await logisticsService.quoteShipment(
        {
          ...(body.carrier ? { carrier: body.carrier } : {}),
          ...(body.orderNumber ? { orderNumber: body.orderNumber } : {}),
          ...(body.fulfillmentNumber ? { fulfillmentNumber: body.fulfillmentNumber } : {}),
          destination: (body.destination ?? {}) as never,
          ...(body.weightGrams !== undefined ? { weightGrams: body.weightGrams } : {}),
          ...(body.codAmount !== undefined ? { codAmount: body.codAmount } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
        },
        getCtx(req),
      );
      return reply.send({ success: true, data: quotes });
    } catch (err) {
      return fail(reply, 400, (err as Error).message);
    }
  }

  // ── Shipment lifecycle ────────────────────────────────────────────

  async createShipment(
    req: FastifyRequest<{
      Body: {
        orderNumber: string;
        fulfillmentNumber: string;
        carrier?: 'redx' | 'pathao' | 'steadfast';
        metadata?: Record<string, unknown>;
        codAmount?: number;
        weightGrams?: number;
        instructions?: string;
      };
    }>,
    reply: FastifyReply,
  ) {
    const body = req.body ?? ({} as never);
    if (!body.orderNumber || !body.fulfillmentNumber) {
      return fail(reply, 400, 'orderNumber and fulfillmentNumber are required');
    }
    try {
      const result = await logisticsService.createShipment(body, getCtx(req));
      return reply.send({ success: true, data: result });
    } catch (err) {
      const e = err as Error;
      const notFound = /not found/i.test(e.message);
      return fail(reply, notFound ? 404 : 400, e.message);
    }
  }

  async trackShipment(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    try {
      const result = await logisticsService.trackShipment(req.params.id, getCtx(req));
      const f = result.fulfillment as Record<string, unknown>;
      return reply.send({
        success: true,
        data: {
          fulfillmentNumber: f.fulfillmentNumber,
          orderNumber: f.orderNumber,
          status: f.status,
          trackingInfo: f.trackingInfo,
          tracking: result.tracking,
        },
      });
    } catch (err) {
      const e = err as Error;
      const notFound = /not found/i.test(e.message);
      return fail(reply, notFound ? 404 : 400, e.message);
    }
  }

  async cancelShipment(
    req: FastifyRequest<{ Params: { id: string }; Body?: { reason?: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const result = await logisticsService.cancelShipment(
        req.params.id,
        req.body?.reason ?? 'Cancelled by merchant',
        getCtx(req),
      );
      const f = result.fulfillment as Record<string, unknown>;
      return reply.send({
        success: true,
        data: {
          fulfillmentNumber: f.fulfillmentNumber,
          orderNumber: f.orderNumber,
          status: f.status,
          trackingInfo: f.trackingInfo,
          voided: result.voided,
        },
      });
    } catch (err) {
      const e = err as Error;
      const notFound = /not found/i.test(e.message);
      return fail(reply, notFound ? 404 : 400, e.message);
    }
  }

  // ── Pickup stores (delegates to RedX or Pathao live API) ──────────

  async getPickupStores(req: FastifyRequest<{ Querystring: { provider?: string } }>, reply: FastifyReply) {
    const provider = (req.query.provider ?? config.logistics.defaultProvider) as 'redx' | 'pathao';
    try {
      if (provider === 'redx') {
        const adapter = carrierRegistry.get('redx') as unknown as {
          listPickupStores: () => Promise<unknown[]>;
        };
        return reply.send({ success: true, data: await adapter.listPickupStores() });
      }
      if (provider === 'pathao') {
        const adapter = carrierRegistry.pathao();
        if (!adapter) return fail(reply, 400, 'Pathao not configured');
        return reply.send({ success: true, data: await adapter.listStores() });
      }
      return fail(reply, 400, `Pickup stores not supported for ${provider}`);
    } catch (err) {
      return fail(reply, 400, (err as Error).message);
    }
  }

  // ── Pathao bulk CSV export ────────────────────────────────────────

  /**
   * Build a Pathao bulk-upload CSV from the orders matching the
   * caller's filters. Filters mirror the orders resource (`status`,
   * `createdAt[gte]`, etc.). Cap of 500 orders per export — UI should
   * paginate larger ranges or stream from a worker.
   */
  async exportPathaoCsv(
    req: FastifyRequest<{
      Querystring: Record<string, string | undefined>;
    }>,
    reply: FastifyReply,
  ) {
    const ctx = getCtx(req);
    const orderCtx: OrderContext = {
      organizationId: ctx.organizationId,
      actorRef: ctx.actorRef ?? 'logistics-csv',
      actorKind: 'system',
      correlationId: ctx.correlationId ?? `csv-${Date.now()}`,
    };
    const engine = await ensureOrderEngine();

    // Translate request query → mongo filter. Reuse the same convention
    // the orders resource uses: bracketed operator suffix => $gte/$lte.
    const filter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (v === undefined || k === 'limit' || k === 'page') continue;
      const m = k.match(/^(.*)\[(gte|lte|gt|lt|ne)\]$/);
      if (m) {
        filter[m[1]!] = { ...(filter[m[1]!] as Record<string, unknown>), [`$${m[2]}`]: v };
      } else {
        filter[k] = v;
      }
    }

    const limit = Math.min(Number(req.query.limit ?? 200), 500);

    // MongoKit Repository.getAll takes `{ filters, page, limit, sort }` as a
    // single options bag and returns an OffsetPaginationResult envelope
    // `{ docs, total, page, limit, pages, hasNext, hasPrev }`. The previous
    // `getAll(filter, opts)` call + array cast silently returned an object,
    // so `.map()` crashed at runtime on the first use. See order.resource.ts
    // line 240 for the canonical invocation.
    const pageResult = (await engine.repositories.order.getAll({
      filters: filter,
      limit,
      sort: '-createdAt',
      ...repoOptionsFromCtx(orderCtx),
    })) as unknown as { docs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const orders: Array<Record<string, unknown>> = Array.isArray(pageResult)
      ? pageResult
      : (pageResult.docs ?? []);

    // Batch-fetch fulfillments keyed by orderNumber so we can read the
    // authoritative shippingAddress for each row. Per @classytic/order, the
    // Order doc itself has NO address fields — address lives on the
    // Fulfillment record created at placement time. Using $in keeps this
    // to a single query regardless of page size (capped at 500 anyway).
    const orderNumbers = orders
      .map((o) => o.orderNumber as string | undefined)
      .filter((n): n is string => !!n);
    let fulfillmentsByOrder = new Map<string, Record<string, unknown>>();
    if (orderNumbers.length > 0) {
      const fulfillmentPage = (await engine.repositories.fulfillment.getAll({
        filters: { orderNumber: { $in: orderNumbers } },
        limit: orderNumbers.length,
        ...repoOptionsFromCtx(orderCtx),
      })) as unknown as
        | { docs?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>;
      const fulfillmentDocs: Array<Record<string, unknown>> = Array.isArray(fulfillmentPage)
        ? fulfillmentPage
        : (fulfillmentPage.docs ?? []);
      fulfillmentsByOrder = new Map(
        fulfillmentDocs.map((f) => [String(f.orderNumber), f] as const),
      );
    }

    const rows: PathaoCsvRow[] = orders.map((o) =>
      orderToPathaoRow(o, fulfillmentsByOrder.get(String(o.orderNumber))),
    );
    const result = buildPathaoBulkCsv(rows);
    const filename = defaultPathaoCsvFilename();

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`);
    // Excel BOM so non-ASCII city / zone names render correctly.
    return reply.send('\uFEFF' + result.csv);
  }

  // ── Webhooks ──────────────────────────────────────────────────────

  /**
   * Carrier-hit webhook endpoint. `x-organization-id` is OPTIONAL —
   * carriers (RedX, Pathao, Steadfast) don't know about our branches and
   * never send it. Tracking numbers are globally unique per carrier, so
   * the service looks the fulfillment up WITHOUT an org filter and
   * resolves the correct `organizationId` from the fulfillment document
   * itself. The `LogisticsContext` built here is used only for
   * `actorRef` / `correlationId` (audit trail) — its `organizationId`,
   * empty or otherwise, is deliberately discarded by `processWebhook`.
   */
  async handleWebhook(req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) {
    try {
      const ctx = getCtx(req);
      const headers = req.headers as Record<string, string>;
      const carrier = req.params.provider as 'redx' | 'pathao' | 'steadfast';
      await logisticsService.processWebhook(carrier, req.body, headers, ctx);
      return reply.send({ success: true });
    } catch (err) {
      req.server.log.error({ err }, 'Webhook processing error');
      return fail(reply, 400, (err as Error).message);
    }
  }
}

// ── Order → PathaoCsvRow mapping (server-side mirror of fe-bigboss/lib) ─
//
// Canonical field reads per the @classytic/order schema:
//   - shipping address → `fulfillment.shippingAddress` (Order doc has no
//     address fields; placement.service writes them onto a Fulfillment)
//   - line items        → `order.lines[]` with `snapshot` metadata
//     (product weight lives on snapshot.weightGrams when the catalog bridge
//     populated it)
//   - notes             → `order.metadata.notes` (POS writes here) with
//     fall-through to a top-level `notes` field for legacy / non-POS orders
//
// The caller batches fulfillment fetches and passes the matching doc in as
// the second arg so this function stays a pure sync mapper. When no
// fulfillment exists (the order was placed without a delivery address —
// e.g. in-store POS pickup) the row still builds but `recipientAddress`
// is blank; the CSV import on Pathao's side will reject it, which is the
// correct signal that the order isn't ready to ship.
export function orderToPathaoRow(
  order: Record<string, unknown>,
  fulfillment?: Record<string, unknown>,
): PathaoCsvRow {
  const addr =
    (fulfillment?.shippingAddress as Record<string, unknown> | undefined) ?? {};

  // Canonical fulfillment schema uses `{ name, phone, line1, line2, city,
  // state, postalCode, country }`. `toFulfillmentAddress` populates these.
  // We still read the FE-shape names as fallbacks for any historical docs
  // written before that translator landed.
  const phone = String(addr.phone ?? addr.recipientPhone ?? '').replace(/\D/g, '');
  const line1 = String(addr.line1 ?? addr.addressLine1 ?? '').trim();
  const line2 = String(addr.line2 ?? addr.addressLine2 ?? '').trim();
  const addressLines = [line1, line2].filter(Boolean).join(', ');

  const totals = order.totals as Record<string, unknown> | undefined;
  const grand = totals?.grandTotal as { amount?: number } | undefined;
  const cod = Math.max(0, Math.round(Number(grand?.amount ?? 0)));

  // Enrich city/zone from carrier-specific IDs on the address, fall back
  // to free-text. Resolution priority:
  //   1. `providerRefs.pathao.{cityId, zoneId}` — canonical home since the
  //      @classytic/order schema added the Mixed `providerRefs` bag.
  //   2. Legacy top-level `pathaoCityId`/`pathaoZoneId` — orders placed
  //      before the schema extension. Mongoose strict stripped these on
  //      save so they only exist on raw-inserted fixtures / historical
  //      data the host backfilled. Kept as a fall-through for safety.
  //   3. Free-text city + line2 — last resort when no IDs are present.
  const providerRefs = (addr as { providerRefs?: Record<string, unknown> }).providerRefs;
  const pathaoRefs = (providerRefs?.pathao as { cityId?: number; zoneId?: number } | undefined) ?? {};
  const cityIdRaw = pathaoRefs.cityId ?? (addr as Record<string, unknown>).pathaoCityId;
  const zoneIdRaw = pathaoRefs.zoneId ?? (addr as Record<string, unknown>).pathaoZoneId;
  let cityName = String(addr.city ?? '').trim();
  let zoneName = String((addr as Record<string, unknown>).zone ?? line2 ?? '').trim();
  if (typeof cityIdRaw === 'number') {
    cityName = findCity(cityIdRaw)?.cityName ?? cityName;
    if (typeof zoneIdRaw === 'number') {
      zoneName = findZone(cityIdRaw, zoneIdRaw)?.zoneName ?? zoneName;
    }
  }

  // Item quantities + weights come from the canonical `order.lines[]`.
  // Legacy `order.items[]` (pre @classytic/order migration) kept here for
  // any historical data that hasn't been reshaped yet — last resort.
  const rawLines = ((order.lines as Array<Record<string, unknown>> | undefined) ??
    (order.items as Array<Record<string, unknown>> | undefined) ??
    []);
  const itemQty = rawLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0) || 1;
  const totalGrams = rawLines.reduce((s, l) => {
    const snap = (l.snapshot as { weightGrams?: number } | undefined) ?? {};
    const perUnit = Number(snap.weightGrams ?? (l as { weightGrams?: number }).weightGrams ?? 0);
    return s + perUnit * (Number(l.quantity) || 1);
  }, 0);
  // Pathao accepts 0.5–10 kg. 0.5 kg default when we have no weight data.
  const weightKg = totalGrams > 0 ? Math.max(0.5, Math.min(10, totalGrams / 1000)) : 0.5;

  // POS stores notes under `metadata.notes`; /orders/place persists them
  // on a top-level `notes` field. Prefer metadata first (explicit), then
  // the legacy top-level.
  const metadata = (order.metadata as Record<string, unknown> | undefined) ?? {};
  const notes = (metadata.notes as string | undefined) ?? (order.notes as string | undefined);

  return {
    itemType: 'parcel',
    merchantOrderId: String(order.orderNumber ?? order._id ?? '').slice(-12),
    recipientName: String(addr.name ?? addr.recipientName ?? '').trim(),
    recipientPhone: phone,
    recipientAddress: addressLines || line1,
    recipientCity: cityName,
    recipientZone: zoneName,
    amountToCollect: cod,
    itemQuantity: itemQty,
    itemWeight: Number(weightKg.toFixed(2)),
    ...(notes ? { specialInstruction: String(notes) } : {}),
  };
}

export default new LogisticsController();
