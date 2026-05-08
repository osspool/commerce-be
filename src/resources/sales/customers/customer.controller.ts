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
 * Self-service field allowlist for `GET /customers/me`.
 *
 * Allowlist not denylist — when admin-only fields get added later (a new
 * compliance flag, an internal score, a CRM projection extension), they
 * stay invisible to the customer until someone explicitly permissions them.
 *
 * Hidden from self-service:
 *   - `notes`                          — internal admin notes
 *   - `creditLimit`, `creditDays`      — internal credit policy
 *   - `tags`                           — admin-side classification
 *   - `priceListId`                    — internal pricing assignment
 *   - `stats`                          — internal aggregates / scoring
 *   - `crm`                            — sales pipeline (stage, owner, score)
 *   - BD VAT/NBR fiscal flags          — `fiscalPositionCode`, `sroReference`,
 *                                        `vdsPayerCategory`, `countryCode`,
 *                                        `isDiplomatic`, `isExemptNgo`,
 *                                        `isSezUnit`, `isRmgFactory`
 *   - `revenueTier`                    — internal classification virtual
 */
const SELF_SERVICE_FIELDS = [
  '_id',
  'userId',
  'name',
  'contact',
  'gender',
  'dateOfBirth',
  'addresses',
  'isActive',
  'membership',
  'customerType',
  'creditEnabled',
  'createdAt',
  'updatedAt',
  'fullName',
  'displayName',
  'defaultAddress',
] as const;

function projectSelfService(customer: unknown): Record<string, unknown> {
  const obj =
    customer && typeof customer === 'object' && 'toObject' in customer && typeof customer.toObject === 'function'
      ? (customer.toObject as (opts: { virtuals: boolean }) => Record<string, unknown>)({ virtuals: true })
      : (customer as Record<string, unknown>);

  const out: Record<string, unknown> = {};
  for (const key of SELF_SERVICE_FIELDS) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
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
    //
    // queryParser is injected automatically by `defineResource` — it reads
    // `resolvedConfig.queryParser` and calls `controller.setQueryParser(qp)`
    // after construction, so the resource-level mongokit parser wins over
    // BaseController's default ArcQueryParser.
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

    return reply.send(projectSelfService(customer));
  }
}

const customerController = new CustomerController(customerRepository, customerSchemaOptions);
export default customerController;
