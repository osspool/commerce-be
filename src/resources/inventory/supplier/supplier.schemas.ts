import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Supplier from './models/supplier.model.js';

const schemaParts = buildCrudSchemasFromModel(Supplier, {
  strictAdditionalProperties: true,
  fieldRules: {
    createdBy: { systemManaged: true },
    updatedBy: { systemManaged: true },
  },
});

const crudSchemas = ((schemaParts as unknown as Record<string, unknown>).crudSchemas as Record<
  string,
  Record<string, unknown>
>) || {
  create: { body: schemaParts.createBody },
  update: { body: schemaParts.updateBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
  delete: { params: schemaParts.params },
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

export const supplierEntitySchema = ((schemaParts as unknown as Record<string, unknown>).entitySchema as Record<
  string,
  unknown
>) || {
  type: 'object',
  additionalProperties: true,
};

export default crudSchemas;
