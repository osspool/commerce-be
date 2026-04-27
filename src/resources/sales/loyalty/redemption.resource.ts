/**
 * Loyalty Redemption Resource.
 *
 * Wraps the @classytic/loyalty redemption repository:
 *
 *   POST /loyalty/redemptions/validate          — dry-run, returns RedemptionValidation
 *   POST /loyalty/redemptions/reserve           — reserves points, returns Redemption
 *   POST /loyalty/redemptions/:redemptionId/action { action: "confirm" | "release" }
 *   GET  /loyalty/redemptions/:redemptionId     — read a single redemption
 *
 * State transitions go through Arc's declarative `actions:` block — same
 * pattern as `member.resource.ts` (deactivate / reactivate / adjust). The
 * engine's `redemption.confirm` / `release` debit or restore the member
 * balance and emit the corresponding domain event.
 *
 * Validate / reserve are normal raw routes because they don't have a
 * redemption id yet — validate does no writes, reserve creates the
 * redemption document.
 */

import { defineResource } from '@classytic/arc';
import { ArcError } from '@classytic/arc/utils';
import type { FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import * as bridge from './loyalty.bridge.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';
import { redemptionSchemas } from './loyalty.schemas.js';
import { loyaltyAction, loyaltyCtx, loyaltyRoute } from './loyalty.utils.js';

const loyaltyEngine = await ensureLoyaltyEngine();

function engine() {
  return loyaltyEngine;
}

const redemptionResource = defineResource({
  name: 'loyalty-redemption',
  displayName: 'Loyalty Redemptions',
  tag: 'Loyalty',
  prefix: '/loyalty/redemptions',
  disableDefaultRoutes: true,

  actions: {
    confirm: {
      handler: loyaltyAction(async (redemptionId, _data, req) => {
        const reqCtx = loyaltyCtx(req);
        const result = await engine().repositories.redemption.confirm(redemptionId, reqCtx);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.redemption.confirm',
            redemptionId,
            memberId: String(result.memberId),
            pointsConfirmed: result.pointsConfirmed,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty redemption confirmed',
        );
        return result;
      }),
      permissions: permissions.customers.update,
    },
    release: {
      handler: loyaltyAction(async (redemptionId, _data, req) => {
        const reqCtx = loyaltyCtx(req);
        const result = await engine().repositories.redemption.release(redemptionId, reqCtx);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.redemption.release',
            redemptionId,
            memberId: String(result.memberId),
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty redemption released',
        );
        return result;
      }),
      permissions: permissions.customers.update,
    },
  },

  routes: [
    {
      method: 'POST',
      path: '/validate',
      summary: 'Dry-run: would this redemption be valid? (no writes)',
      permissions: permissions.customers.update,
      raw: true,
      schema: redemptionSchemas.validate,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId, pointsToRedeem, orderTotal } = req.body as {
          customerId: string;
          pointsToRedeem: number;
          orderTotal: number;
        };
        const reqCtx = loyaltyCtx(req);
        const member = await bridge.requireMemberForCustomer(customerId, reqCtx);
        return engine().repositories.redemption.validate(
          { memberId: member._id as unknown as string, pointsToRedeem, orderTotal },
          reqCtx,
        );
      }),
    },
    {
      method: 'POST',
      path: '/reserve',
      summary: 'Reserve points against an order/cart for redemption',
      permissions: permissions.customers.update,
      raw: true,
      schema: redemptionSchemas.reserve,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId, pointsToRedeem, orderTotal, ownerType, ownerId, expiresAt } = req.body as {
          customerId: string;
          pointsToRedeem: number;
          orderTotal: number;
          ownerType?: string;
          ownerId: string;
          expiresAt?: string;
        };
        const reqCtx = loyaltyCtx(req);
        const member = await bridge.requireMemberForCustomer(customerId, reqCtx);
        const result = await engine().repositories.redemption.reserve(
          {
            memberId: member._id as unknown as string,
            pointsToRedeem,
            orderTotal,
            ownerType: ownerType ?? 'order',
            ownerId,
            ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
          },
          reqCtx,
        );
        req.log.info(
          {
            audit: true,
            op: 'loyalty.redemption.reserve',
            redemptionId: String(result._id),
            customerId,
            memberId: String(member._id),
            pointsReserved: result.pointsReserved,
            discountAmount: result.discountAmount,
            ownerType: result.ownerType,
            ownerId: result.ownerId,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty redemption reserved',
        );
        return result;
      }, 201),
    },
    {
      method: 'GET',
      path: '/:redemptionId',
      summary: 'Get a single redemption by id',
      permissions: permissions.customers.get,
      raw: true,
      schema: redemptionSchemas.byId,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { redemptionId } = req.params as { redemptionId: string };
        const result = await engine().repositories.redemption.getById(redemptionId, {
          throwOnNotFound: false,
        });
        if (!result) {
          throw new ArcError('Redemption not found', { code: 'REDEMPTION_NOT_FOUND', statusCode: 404 });
        }
        return result;
      }),
    },
  ],
});

export default redemptionResource;
