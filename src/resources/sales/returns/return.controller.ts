/**
 * Return Controller — extends Arc BaseController
 *
 * BaseController handles list, get, delete via MongoKit Repository.
 * Overrides: create (delegates to returnService for validation + auto-number).
 */

import type { AnyRecord, IControllerResponse, IRequestContext } from '@classytic/arc';
import { BaseController } from '@classytic/arc';
import returnRepository from './return.repository.js';
import { returnService } from './return.service.js';

class ReturnController extends BaseController {
  constructor() {
    super(returnRepository, {
      tenantField: false,
      schemaOptions: {
        query: {
          filterableFields: {
            status: 'string',
            orderId: 'string',
            customer: 'string',
            customerName: 'string',
            branch: 'string',
          },
        },
      },
    });
  }

  /**
   * Create — delegates to returnService for order validation,
   * return window check, item verification, and auto-numbering.
   */
  override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const userId = (context.user?.id ?? context.user?._id) as string;
    const body = context.body as Record<string, unknown>;

    const returnDoc = await returnService.createReturn(
      body.orderId as string,
      body.items as Array<{ productId: string; variantSku?: string; quantity: number; reason: string }>,
      userId,
      {
        notes: body.notes as string | undefined,
        refundMethod: body.refundMethod as 'original' | 'store_credit' | undefined,
        windowDays: body.windowDays as number | undefined,
      },
    );

    return {
      success: true,
      data: returnDoc as unknown as AnyRecord,
      status: 201,
      meta: { message: `Return ${returnDoc.returnNumber} created` },
    };
  }
}

export default new ReturnController();
