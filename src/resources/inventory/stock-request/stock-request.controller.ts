/**
 * Stock Request Controller — extends Arc's BaseController
 *
 * Only overrides `create` (request number generation, branch validation,
 * item enrichment). All other CRUD operations handled by BaseController.
 */

import type { AnyRecord, IControllerResponse, IRequestContext } from '@classytic/arc';
import { BaseController } from '@classytic/arc';
import stockRequestRepository from './stock-request.repository.js';
import stockRequestService from './stock-request.service.js';

class StockRequestController extends BaseController {
  constructor() {
    super(stockRequestRepository);
  }

  override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const userId = String(context.user?._id || context.user?.id || '');
    const request = await stockRequestService.createRequest(context.body as Record<string, unknown>, userId);
    return {
      success: true,
      data: request as unknown as AnyRecord,
      status: 201,
    };
  }
}

export default new StockRequestController();
