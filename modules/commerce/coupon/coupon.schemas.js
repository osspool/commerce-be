import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Coupon from './coupon.model.js';

export const couponSchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    usedCount: { systemManaged: true },
  },
  query: {
    allowedPopulate: [],
    filterableFields: {
      code: { type: 'string' },
      discountType: { type: 'string' },
      isActive: { type: 'boolean' },
    },
  },
};

export const validateCouponSchema = {
  params: {
    type: 'object',
    properties: {
      code: { type: 'string' },
    },
    required: ['code'],
  },
  body: {
    type: 'object',
    properties: {
      orderAmount: { type: 'number', minimum: 0 },
    },
    required: ['orderAmount'],
  },
};

const crudSchemas = buildCrudSchemasFromModel(Coupon, couponSchemaOptions);

export default crudSchemas;
