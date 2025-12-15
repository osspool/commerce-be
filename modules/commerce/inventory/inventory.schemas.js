import StockEntry from './stockEntry.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Inventory CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - reservedQuantity: systemManaged (updated by order system)
 */
const { crudSchemas } = buildCrudSchemasFromModel(StockEntry, {
  strictAdditionalProperties: true,
  fieldRules: {
    reservedQuantity: { systemManaged: true },
  },
  query: {
    filterableFields: {
      product: 'ObjectId',
      variantSku: 'string',
      barcode: 'string',
      branch: 'ObjectId',
      quantity: 'number',
    },
  },
});

// Export schema options for controller
export const inventorySchemaOptions = {
  query: {
    allowedPopulate: ['product', 'branch'],
    filterableFields: {
      product: 'ObjectId',
      variantSku: 'string',
      barcode: 'string',
      branch: 'ObjectId',
      quantity: 'number',
    },
  },
};

export default crudSchemas;
