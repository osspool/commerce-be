/**
 * Transaction Schemas Index
 * @classytic/revenue
 */

export * from './common.schema.js';
export * from './gateway.schema.js';
export * from './payment.schema.js';
export * from './commission.schema.js';

import { baseMetadataSchema, referenceSchema } from './common.schema.js';
import gatewaySchema from './gateway.schema.js';
import paymentSchemas from './payment.schema.js';
import commissionSchema from './commission.schema.js';

export default {
  baseMetadataSchema,
  referenceSchema,
  gatewaySchema,
  commissionSchema,
  ...paymentSchemas,
};

