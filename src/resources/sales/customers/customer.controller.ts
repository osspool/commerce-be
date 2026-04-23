import { BaseController } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '#shared/utils/errors.js';
import customerRepository from './customer.repository.js';
import { customerSchemaOptions } from './customer.schemas.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
}

/**
 * Customer Controller
 * Handles customer CRUD operations
 *
 * Note: Customer creation is auto-handled by order/checkout workflows.
 * Loyalty operations are handled via /loyalty/* resources (loyalty.resources.ts).
 */
export class CustomerController extends BaseController {
  constructor(service: typeof customerRepository, schemaOptions: typeof customerSchemaOptions) {
    // tenantField: false — customers are company-wide in this
    // single-business multi-branch model. The customer doc has no
    // organizationId field; without this flag Arc's default scope check
    // denies every CRUD hit with ORG_SCOPE_DENIED.
    super(service, { schemaOptions, tenantField: false });
    this.getMe = this.getMe.bind(this);
  }

  async getMe(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = (req as unknown as { user: AuthenticatedUser }).user;
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
      throw new NotFoundError('Customer not found');
    }

    return reply.send({ success: true, data: customer });
  }
}

const customerController = new CustomerController(customerRepository, customerSchemaOptions);
export default customerController;
