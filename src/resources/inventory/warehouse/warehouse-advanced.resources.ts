/**
 * Advanced Warehouse Resources — Lot, Package, Procurement, Replenishment, Cost, Trace, Report
 *
 * Flow-native resources gated by FLOW_MODE. Each resource checks mode before executing.
 * Standard+ features: lot, package, procurement, replenishment, cost layers.
 * Enterprise features: traceability, advanced reports.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  StockLot,
  ReplenishmentRule,
} from '@classytic/flow';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { flowCtx, flow, requireMode } from './helpers.js';
import {
  lotSchemas,
  packageSchemas,
  procurementSchemas,
  replenishmentSchemas,
  costSchemas,
  traceSchemas,
  reportSchemas,
} from './warehouse-advanced.schemas.js';

// ── Lot/Serial Tracking Resource (Standard+) ──

export const lotResource = defineResource({
  name: 'lot-tracking',
  displayName: 'Lot/Serial Tracking',
  tag: 'Warehouse - Lots',
  prefix: '/inventory/lots',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List lots/serials',
      description: 'List lot and serial records with filtering.',
      permissions: permissions.inventory.lotView,
      wrapHandler: false,
      schema: lotSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { skuRef, trackingType, status, limit } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (skuRef) filter.skuRef = skuRef;
        if (trackingType) filter.trackingType = trackingType;
        if (status) filter.status = status;

        const docs = await flow().repositories.lot.findMany(filter, ctx);
        const limited = docs.slice(0, Number(limit) || 50);
        return reply.send({ success: true, data: limited, total: docs.length });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get lot/serial by ID',
      permissions: permissions.inventory.lotView,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const lot = await flow().repositories.lot.findById(id, ctx);
        if (!lot) return reply.code(404).send({ success: false, error: 'Lot not found' });
        return reply.send({ success: true, data: lot });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create lot/serial record',
      description: 'Register a new lot (batch) or serial (individual unit) for tracking.',
      permissions: permissions.inventory.lotManage,
      wrapHandler: false,
      schema: lotSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const lot = await flow().repositories.lot.create({
          organizationId: ctx.organizationId,
          ...body,
          status: 'active',
        } as Omit<StockLot, '_id' | 'createdAt' | 'updatedAt'>);
        return reply.code(201).send({ success: true, data: lot });
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update lot/serial',
      description: 'Update lot status (e.g. mark as recalled or expired).',
      permissions: permissions.inventory.lotManage,
      wrapHandler: false,
      schema: lotSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const existing = await flow().repositories.lot.findById(id, ctx);
        if (!existing) return reply.code(404).send({ success: false, error: 'Lot not found' });
        const updated = await flow().repositories.lot.update(id, body as Partial<StockLot>, ctx);
        return reply.send({ success: true, data: updated });
      },
    },
  ],
});

// ── Package Management Resource (Standard+) ──

export const packageResource = defineResource({
  name: 'stock-package',
  displayName: 'Packages',
  tag: 'Warehouse - Packages',
  prefix: '/inventory/packages',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List packages',
      permissions: permissions.inventory.packageView,
      wrapHandler: false,
      schema: packageSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { locationId, parentPackageId } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (locationId) filter.locationId = locationId;
        if (parentPackageId) filter.parentPackageId = parentPackageId;

        const docs = (await (flow() as any).repositories.package?.findMany?.(filter, ctx)) ?? [];
        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create package',
      description: 'Create a package container (box, carton, pallet) for grouping stock.',
      permissions: permissions.inventory.packageManage,
      wrapHandler: false,
      schema: packageSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const pkg = await flow().services.package.create(body as any, ctx);
        return reply.code(201).send({ success: true, data: pkg });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get package by ID',
      permissions: permissions.inventory.packageView,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const pkg =
          (await flow().services.package.findByBarcode?.(id, ctx)) ??
          (await (flow() as any).repositories.package?.findById?.(id, ctx));
        if (!pkg) return reply.code(404).send({ success: false, error: 'Package not found' });
        return reply.send({ success: true, data: pkg });
      },
    },
    {
      method: 'GET',
      path: '/:id/contents',
      summary: 'Get package contents',
      description: 'List child packages and stock quants inside this package.',
      permissions: permissions.inventory.packageView,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const contents = await flow().services.package.getContents(id, ctx);
        return reply.send({ success: true, data: contents });
      },
    },
    {
      method: 'POST',
      path: '/:id/nest',
      summary: 'Nest a package inside another',
      permissions: permissions.inventory.packageManage,
      wrapHandler: false,
      schema: packageSchemas.nest,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const { childPackageId } = req.body as { childPackageId: string };
        await flow().services.package.nest(childPackageId, id, ctx);
        return reply.send({ success: true, data: { nested: true } });
      },
    },
    {
      method: 'POST',
      path: '/:id/unnest',
      summary: 'Remove package from parent',
      permissions: permissions.inventory.packageManage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        await flow().services.package.unnest(id, ctx);
        return reply.send({ success: true, data: { unnested: true } });
      },
    },
  ],
});

// ── Procurement Orders Resource (Standard+) ──

export const procurementResource = defineResource({
  name: 'procurement',
  displayName: 'Procurement Orders',
  tag: 'Warehouse - Procurement',
  prefix: '/inventory/procurement',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List procurement orders',
      permissions: permissions.inventory.procurementView,
      wrapHandler: false,
      schema: procurementSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { status, vendorRef } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (status) filter.status = status;
        if (vendorRef) filter.vendorRef = vendorRef;

        const docs = await flow().repositories.procurement.findMany(filter, ctx);
        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get procurement order',
      permissions: permissions.inventory.procurementView,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const doc = await flow().repositories.procurement.findById(id, ctx);
        if (!doc) return reply.code(404).send({ success: false, error: 'Procurement order not found' });
        return reply.send({ success: true, data: doc });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create procurement order',
      description: 'Create a procurement order (purchase order via Flow). Items map to receipt moves on receive.',
      permissions: permissions.inventory.procurementCreate,
      wrapHandler: false,
      schema: procurementSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const result = await flow().services.procurement.create(body as any, ctx);
        return reply.code(201).send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/:id/receive',
      summary: 'Receive procurement items',
      description: 'Receive items against a procurement order. Creates receipt moves and updates quants.',
      permissions: permissions.inventory.procurementReceive,
      wrapHandler: false,
      schema: procurementSchemas.receive,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const result = await flow().services.procurement.receive(id, body as any, ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Procurement action (approve/cancel)',
      permissions: permissions.inventory.procurementApprove,
      wrapHandler: false,
      schema: procurementSchemas.action,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const { action } = req.body as { action: string };

        if (action === 'approve') {
          const result = await flow().services.procurement.approve(id, ctx);
          return reply.send({ success: true, data: result });
        }
        if (action === 'cancel') {
          const result = await flow().services.procurement.cancel(id, ctx);
          return reply.send({ success: true, data: result });
        }
        return reply.code(400).send({ success: false, error: `Invalid action '${action}'. Valid: approve, cancel` });
      },
    },
  ],
});

// ── Replenishment Rules Resource (Standard+) ──

export const replenishmentResource = defineResource({
  name: 'replenishment',
  displayName: 'Replenishment Rules',
  tag: 'Warehouse - Replenishment',
  prefix: '/inventory/replenishment',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List replenishment rules',
      permissions: permissions.inventory.replenishmentView,
      wrapHandler: false,
      schema: replenishmentSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { skuRef, scopeId, isActive } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (skuRef) filter.skuRef = skuRef;
        if (scopeId) filter.scopeId = scopeId;
        if (isActive !== undefined) filter.isActive = isActive === 'true';

        const docs = await flow().repositories.replenishmentRule.findMany(filter, ctx);
        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get replenishment rule',
      permissions: permissions.inventory.replenishmentView,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const doc = await flow().repositories.replenishmentRule.findById(id, ctx);
        if (!doc) return reply.code(404).send({ success: false, error: 'Rule not found' });
        return reply.send({ success: true, data: doc });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create replenishment rule',
      description:
        'Define auto-replenishment: when stock drops below reorderPoint, generate procurement up to targetLevel.',
      permissions: permissions.inventory.replenishmentManage,
      wrapHandler: false,
      schema: replenishmentSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const doc = await flow().repositories.replenishmentRule.create({
          organizationId: ctx.organizationId,
          ...body,
          isActive: true,
        } as unknown as Omit<ReplenishmentRule, '_id' | 'createdAt' | 'updatedAt'>);
        return reply.code(201).send({ success: true, data: doc });
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update replenishment rule',
      permissions: permissions.inventory.replenishmentManage,
      wrapHandler: false,
      schema: replenishmentSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;
        const existing = await flow().repositories.replenishmentRule.findById(id, ctx);
        if (!existing) return reply.code(404).send({ success: false, error: 'Rule not found' });
        const updated = await flow().repositories.replenishmentRule.update(id, body as Partial<ReplenishmentRule>, ctx);
        return reply.send({ success: true, data: updated });
      },
    },
    {
      method: 'DELETE',
      path: '/:id',
      summary: 'Delete replenishment rule',
      permissions: permissions.inventory.replenishmentManage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        await flow().repositories.replenishmentRule.delete(id, ctx);
        return reply.send({ success: true, data: { deleted: true } });
      },
    },
    {
      method: 'POST',
      path: '/evaluate',
      summary: 'Evaluate replenishment rules',
      description:
        'Check all rules against current stock levels. With dryRun=true, returns triggers without creating orders.',
      permissions: permissions.inventory.replenishmentManage,
      wrapHandler: false,
      schema: replenishmentSchemas.evaluate,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { skuRef, nodeId, dryRun } = req.body as { skuRef?: string; nodeId?: string; dryRun?: boolean };

        const evaluation = await flow().services.replenishment.evaluateRules({ skuRef, nodeId } as any, ctx);

        if (dryRun || !evaluation.triggers.length) {
          return reply.send({ success: true, data: { triggers: evaluation.triggers, ordersCreated: 0 } });
        }

        const orders = await flow().services.replenishment.generateDemand(evaluation, ctx);
        return reply.send({ success: true, data: { triggers: evaluation.triggers, ordersCreated: orders.length, orders } });
      },
    },
  ],
});

// ── Cost Layers & Valuation Resource (Standard+) ──

export const costResource = defineResource({
  name: 'cost-layers',
  displayName: 'Cost Layers & Valuation',
  tag: 'Warehouse - Cost',
  prefix: '/inventory/cost',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/valuation',
      summary: 'Get inventory valuation',
      description: 'Aggregated cost valuation per SKU/location. Uses configured valuation method (FIFO/FEFO/WAC).',
      permissions: permissions.inventory.costView,
      wrapHandler: false,
      schema: costSchemas.valuation,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { skuRef, locationId, nodeId } = req.query as Record<string, string | undefined>;
        const result = await flow().services.costLayer.getValuation(skuRef ?? '', locationId ?? '', ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/layers',
      summary: 'List cost layers',
      description: 'View individual cost layers (FIFO/FEFO order) for a specific SKU.',
      permissions: permissions.inventory.costView,
      wrapHandler: false,
      schema: costSchemas.layers,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('standard', reply)) return;
        const ctx = flowCtx(req);
        const { skuRef, locationId } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (skuRef) filter.skuRef = skuRef;
        if (locationId) filter.locationId = locationId;

        const docs = await flow().repositories.costLayer.findMany(filter, ctx);
        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
  ],
});

// ── Traceability Resource (Enterprise) ──

export const traceResource = defineResource({
  name: 'traceability',
  displayName: 'Traceability',
  tag: 'Warehouse - Traceability',
  prefix: '/inventory/trace',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/lot',
      summary: 'Trace lot movement history',
      description: 'Full backward/forward traceability for a lot: all moves, current locations, shipments.',
      permissions: permissions.inventory.traceView,
      wrapHandler: false,
      schema: traceSchemas.traceLot,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('enterprise', reply)) return;
        const ctx = flowCtx(req);
        const { lotCode, skuRef } = req.query as { lotCode: string; skuRef: string };
        const result = await flow().services.trace.traceLot(lotCode, skuRef, ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/serial',
      summary: 'Trace serial number',
      description: 'Full movement history for a specific serial number.',
      permissions: permissions.inventory.traceView,
      wrapHandler: false,
      schema: traceSchemas.traceSerial,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('enterprise', reply)) return;
        const ctx = flowCtx(req);
        const { serialCode, skuRef } = req.query as { serialCode: string; skuRef: string };
        const result = await flow().services.trace.traceSerial(serialCode, skuRef, ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/recall',
      summary: 'Recall analysis for a lot',
      description: 'Identify all locations and shipments affected by a lot recall.',
      permissions: permissions.inventory.traceView,
      wrapHandler: false,
      schema: traceSchemas.recall,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!requireMode('enterprise', reply)) return;
        const ctx = flowCtx(req);
        const { lotCode, skuRef } = req.body as { lotCode: string; skuRef: string };
        const result = await flow().services.trace.recallLot(lotCode, skuRef, ctx);
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

