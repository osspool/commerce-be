/**
 * Warehouse Location Resource — bins, zones, aisles inside a Node.
 *
 * Backed by Flow's Location repository. Supports hierarchical locations,
 * coordinate-based layouts, and a grouped "layout" view for the
 * warehouse-designer UI.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { isSystemLocationCode } from '../../flow/context-helpers.js';
import { flow, flowCtxGuard } from '../shared/helpers.js';
import { locationSchemas } from './location.schemas.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@classytic/arc/utils';

const locationResource = defineResource({
  name: 'warehouse-location',
  displayName: 'Locations',
  tag: 'Warehouse - Locations',
  prefix: '/inventory/locations',
  disableDefaultRoutes: true,
  routeGuards: [flowCtxGuard.preHandler],
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List locations',
      description: 'List locations with optional filters by node, type, parent, or status.',
      permissions: permissions.inventory.view,
      raw: true,
      schema: locationSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { nodeId, type, parentLocationId, status } = req.query as Record<string, string | undefined>;

        if (!nodeId) {
          throw new ValidationError('nodeId query parameter is required');
        }

        let locations = await flow().repositories.location.findAll(
          { nodeId },
          { organizationId: ctx.organizationId, sort: { sortOrder: 1 } },
        );

        if (type) locations = locations.filter((l) => l.type === type);
        if (parentLocationId)
          locations = locations.filter((l) => String(l.parentLocationId ?? '') === parentLocationId);
        if (status) locations = locations.filter((l) => l.status === status);

        return reply.send(locations);
      },
    },
    {
      method: 'GET',
      path: '/layout',
      summary: 'Get warehouse layout (grouped by zone/aisle)',
      description: 'Returns locations grouped by zone → aisle → bay for the warehouse designer and map views.',
      permissions: permissions.inventory.view,
      raw: true,
      schema: locationSchemas.layout,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { nodeId } = req.query as { nodeId: string };

        if (!nodeId) {
          throw new ValidationError('nodeId required');
        }

        const locations = await flow().repositories.location.findAll(
          { nodeId },
          { organizationId: ctx.organizationId, sort: { sortOrder: 1 } },
        );

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

        return reply.send({ nodeId, zones: layout, totalLocations: locations.length });
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get location by ID',
      permissions: permissions.inventory.view,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);
        const loc = await flow().repositories.location.getById(id, {
          organizationId: ctx.organizationId,
          throwOnNotFound: false,
        });
        if (!loc) throw new NotFoundError('Location not found');
        return reply.send(loc);
      },
    },
    {
      method: 'GET',
      path: '/:id/stock',
      summary: 'Get stock at a specific location',
      description: 'Returns aggregated stock availability at a specific location bin.',
      permissions: permissions.inventory.view,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);
        const avail = await flow().services.quant.getAvailability({ locationId: id }, ctx);
        return reply.send(avail);
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create location',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: locationSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const body = req.body as Record<string, unknown>;

        const loc = await flow().repositories.location.create(
          {
            organizationId: ctx.organizationId,
            ...body,
            status: 'active',
          },
          { organizationId: ctx.organizationId },
        );

        return reply.code(201).send(loc);
      },
    },
    {
      method: 'POST',
      path: '/bulk',
      summary: 'Bulk create locations',
      description:
        'Create multiple locations at once (from warehouse designer). All locations must belong to the same node.',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: locationSchemas.bulkCreate,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { nodeId, locations } = req.body as { nodeId: string; locations: Record<string, unknown>[] };

        const created = [];
        for (const loc of locations) {
          const result = await flow().repositories.location.create(
            {
              organizationId: ctx.organizationId,
              nodeId,
              ...loc,
              status: 'active',
            },
            { organizationId: ctx.organizationId },
          );
          created.push(result);
        }

        return reply.code(201).send({ created: created.length, locations: created });
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update location',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: locationSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);
        const body = req.body as Record<string, unknown>;

        const existing = await flow().repositories.location.getById(id, {
          organizationId: ctx.organizationId,
          throwOnNotFound: false,
        });
        if (!existing) throw new NotFoundError('Location not found');

        const updated = await flow().repositories.location.update(id, body, {
          organizationId: ctx.organizationId,
        });
        return reply.send(updated);
      },
    },
    {
      method: 'DELETE',
      path: '/:id',
      summary: 'Delete location',
      description:
        'Deletes a user-created location. Rejects system locations (stock/vendor/customer/adjustment) and locations that still hold stock quants or open reservations.',
      permissions: permissions.inventory.adjust,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);

        const existing = await flow().repositories.location.getById(id, {
          organizationId: ctx.organizationId,
          throwOnNotFound: false,
        });
        if (!existing) throw new NotFoundError('Location not found');

        if (isSystemLocationCode(existing.code)) {
          throw new ForbiddenError('System locations (stock, vendor, customer, adjustment) cannot be deleted');
        }

        const quants = await flow().repositories.quant.findAll(
          { locationId: id },
          { organizationId: ctx.organizationId, limit: 1, lean: true },
        );
        if (quants.length > 0) {
          throw new ConflictError('Location has stock quants. Transfer or adjust stock to zero before deleting.');
        }

        const reservations = await flow().repositories.reservation.findAll(
          { locationId: id, status: { $in: ['active', 'partially_consumed'] } },
          { organizationId: ctx.organizationId, limit: 1, lean: true },
        );
        if (reservations.length > 0) {
          throw new ConflictError('Location has active reservations. Release reservations before deleting.');
        }

        const children = await flow().repositories.location.findAll(
          { parentLocationId: id },
          { organizationId: ctx.organizationId, limit: 1, lean: true },
        );
        if (children.length > 0) {
          throw new ConflictError('Location has child locations. Delete or reparent children first.');
        }

        await flow().repositories.location.delete(id, { organizationId: ctx.organizationId });
        return reply.send({ _id: id });
      },
    },
  ],
});

export default locationResource;
