/**
 * Archive Domain Events
 *
 * Events emitted by the archive module for lifecycle tracking.
 */

export const events = {
  'archive:created': {
    module: 'archive',
    description: 'Emitted when a new archive is created (via /run endpoint)',
    schema: {
      type: 'object',
      required: ['archiveId', 'type', 'recordCount'],
      properties: {
        archiveId: { type: 'string', description: 'Archive ID' },
        type: { type: 'string', enum: ['order', 'transaction', 'stock_movement'], description: 'Archive type' },
        recordCount: { type: 'number', description: 'Number of records archived' },
        sizeBytes: { type: 'number', description: 'Archive file size in bytes' },
        filePath: { type: 'string', description: 'Path to archive file' },
        rangeFrom: { type: 'string', format: 'date-time', description: 'Archive date range start' },
        rangeTo: { type: 'string', format: 'date-time', description: 'Archive date range end' },
      },
    },
  },

  'archive:deleted': {
    module: 'archive',
    description: 'Emitted when an archive is deleted (soft delete)',
    schema: {
      type: 'object',
      required: ['archiveId'],
      properties: {
        archiveId: { type: 'string', description: 'Archive ID' },
        type: { type: 'string', description: 'Archive type' },
      },
    },
  },

  'archive:purged': {
    module: 'archive',
    description: 'Emitted when an archive is permanently purged by superadmin',
    schema: {
      type: 'object',
      required: ['archiveId'],
      properties: {
        archiveId: { type: 'string', description: 'Archive ID' },
        filePath: { type: 'string', description: 'Deleted file path' },
        type: { type: 'string', description: 'Archive type' },
      },
    },
  },
};

export const handlers = {
  // Archive module doesn't subscribe to other events yet
  // Can add handlers here if needed in the future
};
