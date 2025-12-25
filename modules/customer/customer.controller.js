import BaseController from '#common/controllers/baseController.js';
import customerRepository from './customer.repository.js';
import { customerSchemaOptions } from './customer.schemas.js';

/**
 * Customer Controller
 * Handles customer CRUD operations
 *
 * Note: Customer creation is auto-handled by order/checkout workflows.
 * Membership actions are handled via handlers/membership.handler.js
 */
export class CustomerController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, schemaOptions);
    this.getMe = this.getMe.bind(this);
  }

  async getMe(req, reply) {
    try {
      const user = req.user;
      const userId = user?._id || user?.id;

      let customer = null;
      if (userId) {
        customer = await customerRepository.getByUserId(userId);
      }

      // Fallback: create/link if not found
      if (!customer && user) {
        customer = await customerRepository.linkOrCreateForUser(user);
      }

      if (!customer) {
        return reply.code(404).send({ success: false, message: 'Customer not found' });
      }

      return reply.send({ success: true, data: customer });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ success: false, message: error.message });
    }
  }
}

const customerController = new CustomerController(customerRepository, customerSchemaOptions);
export default customerController;
