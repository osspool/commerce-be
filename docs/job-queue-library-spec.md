# Job Queue Library Specification

## Package Structure

```
@yourorg/mongo-job-queue/
├── src/
│   ├── index.js              # Main exports
│   ├── JobQueue.js           # Core queue class
│   ├── Job.schema.js         # Mongoose schema (not model)
│   └── types.d.ts            # TypeScript definitions
├── package.json
└── README.md
```

## Core API

```js
import { createJobQueue, createJobSchema } from '@yourorg/mongo-job-queue';

// In your app's model file
const Job = mongoose.model('Job', createJobSchema({
  // Optional: extend with org-specific fields
  organization: { type: Schema.Types.ObjectId, ref: 'Organization' },
}));

// Create queue instance
const jobQueue = createJobQueue({
  jobModel: Job,
  logger: yourLogger,  // Optional, defaults to console
  config: {
    maxRetries: 3,
    retryDelayMs: 1000,
    pollIntervalBase: 1000,
    // ... other config
  },
});

// Register handlers
jobQueue.registerHandler('SEND_EMAIL', async (job) => {
  await sendEmail(job.data);
});

// Start processing
jobQueue.startPolling();
```

## Key Design Decisions

### 1. Schema Factory, Not Model
```js
// Library exports schema factory
export function createJobSchema(extraFields = {}) {
  return new Schema({
    type: { type: String, required: true },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
    data: Schema.Types.Mixed,
    // ... base fields
    ...extraFields,  // Allow extension
  });
}
```

This allows each project to:
- Add org/tenant fields
- Use their own mongoose connection
- Customize indexes

### 2. Dependency Injection
```js
// Library doesn't import mongoose or logger
export function createJobQueue({ jobModel, logger = console, config = {} }) {
  return new PersistentJobQueue(jobModel, logger, config);
}
```

### 3. No Handler Registration in Library
Handlers stay in consuming apps (domain-specific).

## Migration Path

### Step 1: Extract to internal package
```bash
# In your monorepo or npm org
mkdir packages/mongo-job-queue
```

### Step 2: Refactor current code
```js
// Before (current)
import { jobQueue } from '#modules/job/JobQueue.js';

// After (with library)
import { createJobQueue } from '@yourorg/mongo-job-queue';
import Job from './job.model.js';

export const jobQueue = createJobQueue({ jobModel: Job, logger });
```

### Step 3: Keep registry pattern in each app
```js
// This stays in each app - NOT in library
// modules/job/job.registry.js
export async function registerAllJobHandlers() {
  await import('#modules/commerce/pos/pos.jobs.js');
  await import('#modules/inventory/inventory.jobs.js');
}
```

## What Goes Where

| Component | Library | App |
|-----------|---------|-----|
| `PersistentJobQueue` class | ✅ | |
| `createJobSchema()` | ✅ | |
| `Job` model instance | | ✅ |
| `job.registry.js` | | ✅ |
| `pos.jobs.js` handlers | | ✅ |
| Logger instance | | ✅ |

## Versioning Strategy

```
v1.0.0 - Initial extraction
v1.1.0 - Add feature X
v1.1.1 - Bug fix
```

All projects update to same version = consistent behavior.

## Testing

Library includes:
- Unit tests for queue logic (mocked model)
- Integration test example (with mongodb-memory-server)

Apps include:
- Handler-specific tests
- E2E tests with real jobs

## Future Enhancements (v2.0)

- [ ] Redis adapter for distributed locking
- [ ] Prometheus metrics export
- [ ] OpenTelemetry tracing
- [ ] Batch job processing
- [ ] Cron/scheduled jobs
- [ ] Admin UI (optional companion package)
