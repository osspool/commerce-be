/**
 * Job Domain Events
 *
 * Events emitted by the job queue system for lifecycle tracking.
 */

export const events = {
  'job:created': {
    module: 'job',
    description: 'Emitted when a new job is queued for background processing',
    schema: {
      type: 'object',
      required: ['jobId', 'type'],
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        type: { type: 'string', description: 'Job type (e.g., POS_CREATE_TRANSACTION, STOCK_ALERT)' },
        priority: { type: 'number', description: 'Job priority (higher = sooner)' },
        scheduledFor: { type: 'string', format: 'date-time', description: 'When job should run' },
        data: { type: 'object', description: 'Job payload data' },
      },
    },
  },

  'job:started': {
    module: 'job',
    description: 'Emitted when a job begins processing',
    schema: {
      type: 'object',
      required: ['jobId', 'type'],
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        type: { type: 'string', description: 'Job type' },
        attempts: { type: 'number', description: 'Number of attempts so far' },
        startedAt: { type: 'string', format: 'date-time', description: 'Job start time' },
      },
    },
  },

  'job:completed': {
    module: 'job',
    description: 'Emitted when a job completes successfully',
    schema: {
      type: 'object',
      required: ['jobId', 'type'],
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        type: { type: 'string', description: 'Job type' },
        completedAt: { type: 'string', format: 'date-time', description: 'Job completion time' },
        duration: { type: 'number', description: 'Processing duration in milliseconds' },
      },
    },
  },

  'job:failed': {
    module: 'job',
    description: 'Emitted when a job fails or exceeds max retries',
    schema: {
      type: 'object',
      required: ['jobId', 'type', 'error'],
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        type: { type: 'string', description: 'Job type' },
        error: { type: 'string', description: 'Error message' },
        attempts: { type: 'number', description: 'Number of failed attempts' },
        maxRetries: { type: 'number', description: 'Maximum retry limit' },
      },
    },
  },

  'job:retrying': {
    module: 'job',
    description: 'Emitted when a job is retried after failure',
    schema: {
      type: 'object',
      required: ['jobId', 'type', 'attempt'],
      properties: {
        jobId: { type: 'string', description: 'Job ID' },
        type: { type: 'string', description: 'Job type' },
        attempt: { type: 'number', description: 'Current attempt number' },
        maxRetries: { type: 'number', description: 'Maximum retry limit' },
        lastError: { type: 'string', description: 'Previous error message' },
      },
    },
  },
};

export const handlers = {
  // Job module doesn't subscribe to other events yet
  // Job handlers are registered in job.registry.js by specific modules
};
