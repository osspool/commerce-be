import { BaseController } from '@classytic/arc';
import supplierRepository from './supplier.repository.js';
import { supplierSchemaOptions } from './supplier.schemas.js';

class SupplierController extends BaseController {
  constructor() {
    super(supplierRepository, { schemaOptions: supplierSchemaOptions });
  }

  async create(context) {
    const userId = context.user?.id ?? context.user?._id;
    const payload = {
      ...context.body,
      createdBy: userId,
      updatedBy: userId,
    };

    const arcContext = context.context;
    const document = await this.repository.create(payload, { context: arcContext, user: context.user });

    return {
      success: true,
      data: document,
      status: 201,
      meta: { message: 'Supplier created successfully' },
    };
  }

  async update(context) {
    const userId = context.user?.id ?? context.user?._id;
    const payload = {
      ...context.body,
      updatedBy: userId,
    };

    const arcContext = context.context;
    const document = await this.repository.update(
      context.params.id,
      payload,
      { context: arcContext, user: context.user }
    );

    return {
      success: true,
      data: document,
      status: 200,
      meta: { message: 'Supplier updated successfully' },
    };
  }

  async delete(context) {
    const userId = context.user?.id ?? context.user?._id;
    const arcContext = context.context;

    await this.repository.update(
      context.params.id,
      {
        isActive: false,
        updatedBy: userId,
      },
      { context: arcContext, user: context.user }
    );

    return {
      success: true,
      data: { message: 'Supplier deactivated' },
      status: 200,
    };
  }
}

export default new SupplierController();
