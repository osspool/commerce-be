import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import Customer from './customer.model.js';

/**
 * Customer CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - userId: systemManaged (auto-linked from user)
 * - stats.*: systemManaged (calculated from orders/subscriptions)
 */
const crudSchemas: CrudSchemas = buildCrudSchemasFromModel(Customer, {
  strictAdditionalProperties: true, // Reject unknown fields at schema level
  fieldRules: {
    userId: { systemManaged: true },
    'stats.orders.total': { systemManaged: true },
    'stats.orders.completed': { systemManaged: true },
    'stats.orders.cancelled': { systemManaged: true },
    'stats.orders.refunded': { systemManaged: true },
    'stats.revenue.total': { systemManaged: true },
    'stats.revenue.lifetime': { systemManaged: true },
    'stats.subscriptions.active': { systemManaged: true },
    'stats.subscriptions.cancelled': { systemManaged: true },
    'stats.lastOrderDate': { systemManaged: true },
    'stats.firstOrderDate': { systemManaged: true },
  },
});

// Export schema options for controller
export const customerSchemaOptions = {
  query: {
    allowedPopulate: ['userId'],
    filterableFields: {
      'name.given': 'string',
      'name.family': 'string',
      'contact.phone': 'string',
      'contact.email': 'string',
      userId: 'ObjectId',
      customerType: 'string',
      'crm.stage': 'string',
      'crm.ownerId': 'string',
      'crm.accountId': 'string',
    },
  },
};

export default crudSchemas;
