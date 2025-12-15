import Archive from './archive.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Archive CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - All fields are systemManaged (archives are created by /run endpoint)
 * - Users can only view, download, or purge (superadmin) archives
 */
const { crudSchemas } = buildCrudSchemasFromModel(Archive, {
  fieldRules: {
    type: { systemManaged: true },
    organizationId: { systemManaged: true },
    rangeFrom: { systemManaged: true },
    rangeTo: { systemManaged: true },
    filePath: { systemManaged: true },
    format: { systemManaged: true },
    recordCount: { systemManaged: true },
    sizeBytes: { systemManaged: true },
    archivedAt: { systemManaged: true },
    expiresAt: { systemManaged: true },
  },
  query: {
    filterableFields: {
      type: 'string',
      organizationId: 'ObjectId',
    },
  },
});

// Export schema options for controller
export const archiveSchemaOptions = {
  query: {
    allowedPopulate: ['organizationId'],
    filterableFields: {
      type: 'string',
      organizationId: 'ObjectId',
    },
  },
};

export const archiveSchemas = crudSchemas;
export default archiveSchemas;

export const archiveRunQuery = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['order', 'transaction', 'membership'] },
    organizationId: { type: 'string' },
    rangeFrom: { type: 'string', format: 'date-time' },
    rangeTo: { type: 'string', format: 'date-time' },
    ttlDays: { type: 'number', minimum: 1 },
  },
  additionalProperties: false,
};
