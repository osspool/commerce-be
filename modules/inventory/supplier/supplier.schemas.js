import Supplier from './models/supplier.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

const schemaParts = buildCrudSchemasFromModel(Supplier, {
  strictAdditionalProperties: true,
  fieldRules: {
    createdBy: { systemManaged: true },
    updatedBy: { systemManaged: true },
  },
  query: {
    filterableFields: {
      name: 'string',
      code: 'string',
      type: 'string',
      paymentTerms: 'string',
      isActive: 'boolean',
    },
  },
});

const crudSchemas = schemaParts.crudSchemas || {
  create: { body: schemaParts.createBody },
  update: { body: schemaParts.updateBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
  remove: { params: schemaParts.params },
};

export const supplierSchemaOptions = {
  query: {
    filterableFields: {
      name: 'string',
      code: 'string',
      type: 'string',
      paymentTerms: 'string',
      isActive: 'boolean',
    },
  },
};

export const supplierEntitySchema = schemaParts.entitySchema || {
  type: 'object',
  additionalProperties: true,
};

export default crudSchemas;
