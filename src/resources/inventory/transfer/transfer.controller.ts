/**
 * Transfer Controller — extends Arc's BaseController
 *
 * Only overrides `create` (document number generation, type determination,
 * status init, Flow stock validation, role-based transfer type enforcement).
 * All other CRUD operations (list, get, update, delete) are handled by
 * BaseController via the adapter.
 */

import type { AnyRecord, IControllerResponse, IRequestContext } from '@classytic/arc';
import { BaseController } from '@classytic/arc';
import permissions from '#config/permissions.js';
import transferRepository from './transfer.repository.js';
import transferService from './transfer.service.js';

class TransferController extends BaseController {
  constructor() {
    super(transferRepository);
  }

  override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    try {
      const userId = String(context.user?._id || context.user?.id || '');
      const userRoles = Array.isArray(context.user?.role) ? (context.user.role as string[]) : [];
      const hasRole = (allowed: string[] = []): boolean => allowed.some((r) => userRoles.includes(r));

      // Resolve the caller's authenticated branch from scope/org context
      const callerBranchId =
        (context as any).scope?.organizationId ??
        (context.user as any)?.organizationId ??
        (context.user as any)?.orgId ??
        '';

      const transfer = await transferService.createTransfer(context.body as Record<string, unknown>, userId, {
        canSubBranchTransfer: hasRole([...(permissions.inventory.subBranchTransfer._roles || [])]),
        canReturnToHead: hasRole([...(permissions.inventory.returnToHead._roles || [])]),
        callerBranchId,
      });
      return {
        success: true,
        data: transfer as unknown as AnyRecord,
        status: 201,
      };
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      return {
        success: false,
        error: err.message,
        status: err.statusCode || 400,
      };
    }
  }
}

export default new TransferController();
