import Transaction from './transaction.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

export const transactionSchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    customerId: { immutable: true },
    orderId: { immutable: true },
    referenceId: { immutable: true },
    referenceModel: { immutable: true },
    type: { immutable: true },
    category: { immutable: true },
    gateway: { systemManaged: true },
    webhook: { systemManaged: true },
    verifiedAt: { systemManaged: true },
    verifiedBy: { systemManaged: true },
    metadata: { systemManaged: true },
  },
  create: {
    optionalOverrides: {
      type: true,
      status: true,
    },
  },
  query: {
    allowedPopulate: ['customerId', 'orderId', 'referenceId'],
    filterableFields: {
      customerId: { type: 'string' },
      orderId: { type: 'string' },
      referenceId: { type: 'string' },
      referenceModel: { type: 'string' },
      type: { type: 'string' },
      method: { type: 'string' },
      category: { type: 'string' },
      status: { type: 'string' },
      transactionDate: { type: 'string', format: 'date-time' },
    },
  },
  filter: {
    selectForRole: {
      user: '-webhook.payload -metadata',
      admin: '-webhook.payload',
    },
  },
};

const { crudSchemas } = buildCrudSchemasFromModel(Transaction, transactionSchemaOptions);

export default crudSchemas;
