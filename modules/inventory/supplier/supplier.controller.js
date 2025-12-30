import BaseController from '#core/base/BaseController.js';
import supplierRepository from './supplier.repository.js';
import { supplierSchemaOptions } from './supplier.schemas.js';

class SupplierController extends BaseController {
  constructor() {
    super(supplierRepository, supplierSchemaOptions);
  }

  async create(req, reply) {
    const payload = {
      ...req.body,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    };

    const document = await this.service.create(payload, this._buildContext(req));
    return reply.code(201).send({ success: true, data: document });
  }

  async update(req, reply) {
    const payload = {
      ...req.body,
      updatedBy: req.user?._id,
    };

    const document = await this.service.update(req.params.id, payload, this._buildContext(req));
    return reply.code(200).send({ success: true, data: document });
  }

  async delete(req, reply) {
    await this.service.update(req.params.id, {
      isActive: false,
      updatedBy: req.user?._id,
    }, this._buildContext(req));

    return reply.code(200).send({
      success: true,
      message: 'Supplier deactivated',
    });
  }
}

export default new SupplierController();
