/**
 * Warehouse Resources — Node, Location, Audit
 *
 * Arc resources backed by Flow's repositories and counting service.
 * All org-scoped via Better Auth (x-organization-id header).
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { InventoryNode, Location } from '@classytic/flow';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { flowCtx, flow } from './helpers.js';
import { nodeSchemas, locationSchemas, auditSchemas } from './warehouse.schemas.js';

// ── Node (Warehouse) Resource ──

export const nodeResource = defineResource({
  name: 'warehouse-node',
  displayName: 'Warehouses',
  tag: 'Warehouse',
  prefix: '/inventory/nodes',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List warehouse nodes',
      description: 'Returns all warehouses/stores for the current organization.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const nodes = await flow().repositories.node.list(ctx);
        return reply.send({ success: true, data: nodes });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get warehouse by ID',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const node = await flow().repositories.node.findById(id, ctx);
        if (!node) return reply.code(404).send({ success: false, error: 'Warehouse not found' });
        return reply.send({ success: true, data: node });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create warehouse',
      description: 'Create a new warehouse node. Plan limits enforced (standard=1/branch, enterprise=unlimited).',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: nodeSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;

        // Plan-based limit: check how many nodes already exist
        const mode = flow().services.mode;
        if (mode === 'simple' || mode === 'standard') {
          const existing = await flow().repositories.node.list(ctx);
          if (existing.length >= 1) {
            return reply.code(400).send({
              success: false,
              error: `Only 1 warehouse allowed on '${mode}' plan. Upgrade to enterprise for multiple warehouses.`,
            });
          }
        }

        const node = await flow().repositories.node.create({
          organizationId: ctx.organizationId,
          ...body,
          status: 'active',
        } as Omit<InventoryNode, '_id' | 'createdAt' | 'updatedAt'>);

        return reply.code(201).send({ success: true, data: node });
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update warehouse',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: nodeSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;

        const existing = await flow().repositories.node.findById(id, ctx);
        if (!existing) return reply.code(404).send({ success: false, error: 'Warehouse not found' });

        const updated = await flow().repositories.node.update(id, body as Partial<InventoryNode>, ctx);
        return reply.send({ success: true, data: updated });
      },
    },
  ],
});

// ── Location Resource ──

export const locationResource = defineResource({
  name: 'warehouse-location',
  displayName: 'Locations',
  tag: 'Warehouse - Locations',
  prefix: '/inventory/locations',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List locations',
      description: 'List locations with optional filters by node, type, parent, or status.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      schema: locationSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const { nodeId, type, parentLocationId, status } = req.query as Record<string, string | undefined>;

        if (!nodeId) {
          return reply.code(400).send({ success: false, error: 'nodeId query parameter is required' });
        }

        let locations = await flow().repositories.location.findByNode(nodeId, ctx);

        if (type) locations = locations.filter((l) => l.type === type);
        if (parentLocationId) locations = locations.filter((l) => l.parentLocationId === parentLocationId);
        if (status) locations = locations.filter((l) => l.status === status);

        return reply.send({ success: true, data: locations, total: locations.length });
      },
    },
    {
      method: 'GET',
      path: '/layout',
      summary: 'Get warehouse layout (grouped by zone/aisle)',
      description: 'Returns locations grouped by zone → aisle → bay for the warehouse designer and map views.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      schema: locationSchemas.layout,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const { nodeId } = req.query as { nodeId: string };

        if (!nodeId) {
          return reply.code(400).send({ success: false, error: 'nodeId required' });
        }

        const locations = await flow().repositories.location.getTree(nodeId, ctx);

        // Group by zone → aisle for the designer/map
        const zones = new Map<string, { zone: string; aisles: Map<number, typeof locations> }>();
        for (const loc of locations) {
          const zone = loc.coordinates?.zone ?? '_ungrouped';
          const aisle = loc.coordinates?.aisle ?? 0;

          if (!zones.has(zone)) {
            zones.set(zone, { zone, aisles: new Map() });
          }
          const zoneData = zones.get(zone)!;
          if (!zoneData.aisles.has(aisle)) {
            zoneData.aisles.set(aisle, []);
          }
          zoneData.aisles.get(aisle)?.push(loc);
        }

        // Convert to serializable structure
        const layout = [...zones.values()]
          .map((z) => ({
            zone: z.zone,
            aisles: [...z.aisles.entries()]
              .sort(([a], [b]) => a - b)
              .map(([aisle, locs]) => ({
                aisle,
                locations: locs.sort((a, b) => (a.coordinates?.bay ?? 0) - (b.coordinates?.bay ?? 0)),
              })),
          }))
          .sort((a, b) => a.zone.localeCompare(b.zone));

        return reply.send({ success: true, data: { nodeId, zones: layout, totalLocations: locations.length } });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get location by ID',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const loc = await flow().repositories.location.findById(id, ctx);
        if (!loc) return reply.code(404).send({ success: false, error: 'Location not found' });
        return reply.send({ success: true, data: loc });
      },
    },
    {
      method: 'GET',
      path: '/:id/stock',
      summary: 'Get stock at a specific location',
      description: 'Returns aggregated stock availability at a specific location bin.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const avail = await flow().services.quant.getAvailability({ locationId: id }, ctx);
        return reply.send({ success: true, data: avail });
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create location',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: locationSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;

        const loc = await flow().repositories.location.create({
          organizationId: ctx.organizationId,
          ...body,
          status: 'active',
        } as Omit<Location, '_id' | 'createdAt' | 'updatedAt'>);

        return reply.code(201).send({ success: true, data: loc });
      },
    },
    {
      method: 'POST',
      path: '/bulk',
      summary: 'Bulk create locations',
      description:
        'Create multiple locations at once (from warehouse designer). All locations must belong to the same node.',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: locationSchemas.bulkCreate,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const { nodeId, locations } = req.body as { nodeId: string; locations: Record<string, unknown>[] };

        const created = [];
        for (const loc of locations) {
          const result = await flow().repositories.location.create({
            organizationId: ctx.organizationId,
            nodeId,
            ...loc,
            status: 'active',
          } as Omit<Location, '_id' | 'createdAt' | 'updatedAt'>);
          created.push(result);
        }

        return reply.code(201).send({ success: true, data: { created: created.length, locations: created } });
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update location',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: locationSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const body = req.body as Record<string, unknown>;

        const existing = await flow().repositories.location.findById(id, ctx);
        if (!existing) return reply.code(404).send({ success: false, error: 'Location not found' });

        const updated = await flow().repositories.location.update(id, body as Partial<Location>, ctx);
        return reply.send({ success: true, data: updated });
      },
    },
  ],
});

// ── Audit Resource ──

export const auditResource = defineResource({
  name: 'stock-audit',
  displayName: 'Stock Audits',
  tag: 'Warehouse - Audit',
  prefix: '/inventory/audits',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create audit session',
      description: 'Start a stock count session (full, cycle, or spot check).',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: auditSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        const body = req.body as {
          countType: 'full' | 'cycle' | 'spot';
          scope?: Record<string, unknown>;
          freezePolicy?: string;
        };

        const session = await flow().services.counting.createSession(
          {
            countType: body.countType,
            scope: (body.scope ?? {}) as { nodeId?: string; locationId?: string; skuRefs?: string[] },
            freezePolicy: body.freezePolicy as 'hard_freeze' | 'soft_freeze' | 'none' | undefined,
          },
          ctx,
        );

        return reply.code(201).send({ success: true, data: session });
      },
    },
    {
      method: 'GET',
      path: '/',
      summary: 'List audit sessions',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtx(req);
        // Query directly from the model for list with status filter
        const { status } = req.query as { status?: string };
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (status) filter.status = status;

        const docs = await flow().models.InventoryCount.find(filter).sort({ createdAt: -1 }).limit(50).lean();

        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get audit session',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const session = await flow().services.counting.getById(id, ctx);
        if (!session) return reply.code(404).send({ success: false, error: 'Audit not found' });
        return reply.send({ success: true, data: session });
      },
    },
    {
      method: 'POST',
      path: '/:id/lines',
      summary: 'Submit count lines',
      description: 'Submit counted quantities for locations/SKUs. Supports bulk submission from mobile scan.',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: auditSchemas.submitLines,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const { lines } = req.body as {
          lines: Array<{
            skuRef: string;
            locationId: string;
            lotId?: string;
            serialCode?: string;
            countedQuantity: number;
            varianceReason?: string;
          }>;
        };

        const result = await flow().services.counting.submitLines(id, lines, ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/:id/variance',
      summary: 'Get variance report',
      description: 'Compare counted vs expected quantities. Shows per-bin discrepancies.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const variance = await flow().services.counting.calculateVariance(id, ctx);
        return reply.send({ success: true, data: variance });
      },
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Audit action (reconcile / cancel)',
      description:
        'Reconcile: auto-approve small variances, create adjustment moves for the rest. Cancel: abort the audit.',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtx(req);
        const { action, ...data } = req.body as { action: string; [key: string]: unknown };

        if (action === 'reconcile') {
          const result = await flow().services.counting.reconcile(
            id,
            {
              autoApproveThreshold: data.autoApproveThreshold as number | undefined,
            },
            ctx,
          );
          return reply.send({ success: true, data: result });
        }

        if (action === 'post-moves') {
          await flow().services.counting.postReconciliationMoves(id, ctx);
          return reply.send({ success: true, data: { posted: true } });
        }

        return reply.code(400).send({
          success: false,
          error: `Invalid action '${action}'. Valid: reconcile, post-moves`,
        });
      },
    },
  ],
});
