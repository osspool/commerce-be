import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse, AnyRecord } from '@classytic/arc';
import supplierRepository from './supplier.repository.js';
import { supplierSchemaOptions } from './supplier.schemas.js';

class SupplierController extends BaseController {
  constructor() {
    super(supplierRepository, { schemaOptions: supplierSchemaOptions });
  }

  override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const userId = context.user?.id ?? context.user?._id;
    const payload = {
      ...(context.body as Record<string, unknown>),
      createdBy: userId,
      updatedBy: userId,
    };

    const arcContext = context.context;
    const document = await this.repository.create(payload, { context: arcContext, user: context.user });

    return {
      success: true,
      data: document as AnyRecord,
      status: 201,
      meta: { message: 'Supplier created successfully' },
    };
  }

  override async update(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
    const userId = context.user?.id ?? context.user?._id;
    const payload = {
      ...(context.body as Record<string, unknown>),
      updatedBy: userId,
    };

    const arcContext = context.context;
    const document = await this.repository.update(context.params.id, payload, {
      context: arcContext,
      user: context.user,
    });

    return {
      success: true,
      data: document as AnyRecord,
      status: 200,
      meta: { message: 'Supplier updated successfully' },
    };
  }

  override async delete(
    context: IRequestContext,
  ): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    const userId = context.user?.id ?? context.user?._id;
    const arcContext = context.context;

    await this.repository.update(
      context.params.id,
      {
        isActive: false,
        updatedBy: userId,
      },
      { context: arcContext, user: context.user },
    );

    return {
      success: true,
      data: { message: 'Supplier deactivated' },
      status: 200,
    };
  }
}

export default new SupplierController();
