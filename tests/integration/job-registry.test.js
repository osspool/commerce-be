/**
 * Job Registry Tests
 *
 * Tests for the module-wise job registration pattern.
 */

process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { jobQueue } from '../../modules/job/JobQueue.js';
import Job from '../../modules/job/job.model.js';

describe('Job Registry Pattern', () => {
  let app;

  beforeAll(async () => {
    if (globalThis.__MONGO_URI__) {
      process.env.MONGO_URI = globalThis.__MONGO_URI__;
    }

    process.env.JWT_SECRET = 'test-secret-key-123456789';
    process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

    const { createTestServer } = await import('../helpers/test-utils.js');
    app = await createTestServer();
    await Job.deleteMany({});
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('Module Job Registration', () => {
    it('should have POS_CREATE_TRANSACTION handler registered', () => {
      const hasHandler = jobQueue.jobHandlers.has('POS_CREATE_TRANSACTION');
      expect(hasHandler).toBe(true);
    });

    it('should have INVENTORY_CONSISTENCY_CHECK handler registered', () => {
      const hasHandler = jobQueue.jobHandlers.has('INVENTORY_CONSISTENCY_CHECK');
      expect(hasHandler).toBe(true);
    });

    it('should have STOCK_ALERT handler registered', () => {
      const hasHandler = jobQueue.jobHandlers.has('STOCK_ALERT');
      expect(hasHandler).toBe(true);
    });
  });

  describe('POS Job Types', () => {
    it('should export POS_JOB_TYPES correctly', async () => {
      const { POS_JOB_TYPES } = await import('../../modules/sales/pos/pos.jobs.js');

      expect(POS_JOB_TYPES).toBeDefined();
      expect(POS_JOB_TYPES.CREATE_TRANSACTION).toBe('POS_CREATE_TRANSACTION');
    });

    it('should add POS transaction job to queue', async () => {
      const { POS_JOB_TYPES } = await import('../../modules/sales/pos/pos.jobs.js');

      // Add job (without processing - just test queue insertion)
      const job = await jobQueue.add({
        type: POS_JOB_TYPES.CREATE_TRANSACTION,
        priority: 10,
        data: {
          orderId: 'test-order-123',
          customerId: 'test-customer',
          totalAmount: 1000,
          branchId: 'test-branch',
          branchCode: 'BR001',
          cashierId: 'test-cashier',
          paymentMethod: 'cash',
          idempotencyKey: 'test-idempotency-key',
        },
      });

      expect(job).toBeDefined();
      expect(job.type).toBe('POS_CREATE_TRANSACTION');
      expect(job.priority).toBe(10);
      expect(job.data.orderId).toBe('test-order-123');
      expect(job.status).toBe('pending');

      // Cleanup
      await Job.findByIdAndDelete(job._id);
    });
  });

  describe('Inventory Job Types', () => {
    it('should export INVENTORY_JOB_TYPES correctly', async () => {
      const { INVENTORY_JOB_TYPES } = await import('../../modules/inventory/inventory.jobs.js');

      expect(INVENTORY_JOB_TYPES).toBeDefined();
      expect(INVENTORY_JOB_TYPES.CONSISTENCY_CHECK).toBe('INVENTORY_CONSISTENCY_CHECK');
      expect(INVENTORY_JOB_TYPES.STOCK_ALERT).toBe('STOCK_ALERT');
    });

    it('should add stock alert job to queue', async () => {
      const { INVENTORY_JOB_TYPES } = await import('../../modules/inventory/inventory.jobs.js');

      const job = await jobQueue.add({
        type: INVENTORY_JOB_TYPES.STOCK_ALERT,
        data: {
          productId: 'test-product',
          branchId: 'test-branch',
          quantity: 5,
          reorderPoint: 10,
        },
      });

      expect(job).toBeDefined();
      expect(job.type).toBe('STOCK_ALERT');
      expect(job.data.quantity).toBe(5);

      // Cleanup
      await Job.findByIdAndDelete(job._id);
    });
  });

  describe('Handler Testability', () => {
    it('should allow direct testing of POS handler function', async () => {
      const { handleCreateTransaction } = await import('../../modules/sales/pos/pos.jobs.js');

      // Handler should be a function
      expect(typeof handleCreateTransaction).toBe('function');
    });

    it('should allow direct testing of inventory handler functions', async () => {
      const { handleConsistencyCheck, handleStockAlert } = await import(
        '../../modules/inventory/inventory.jobs.js'
      );

      expect(typeof handleConsistencyCheck).toBe('function');
      expect(typeof handleStockAlert).toBe('function');
    });
  });

  describe('Job Queue Stats', () => {
    it('should return queue statistics', async () => {
      const stats = await jobQueue.getStats();

      expect(stats).toBeDefined();
      expect(typeof stats.pending).toBe('number');
      expect(typeof stats.processing).toBe('number');
      expect(typeof stats.completed).toBe('number');
      expect(typeof stats.failed).toBe('number');
      expect(typeof stats.total).toBe('number');
      expect(stats.isPolling).toBe(true);
      expect(stats.isShuttingDown).toBe(false);
    });
  });
});
