// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
// Dynamic import will be used for createTestServer
import { jobQueue } from '../../modules/job/JobQueue.js';
import Job from '../../modules/job/job.model.js';

describe('Smart Persistent Job Queue', () => {
    let app;

    beforeAll(async () => {
        // Manually setting MONGO_URI if available (sometimes globalThis isn't propagated to app)
        if (globalThis.__MONGO_URI__) {
            process.env.MONGO_URI = globalThis.__MONGO_URI__;
        }
        
        process.env.JWT_SECRET = 'test-secret-key-123456789';
        process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
        process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

        // Dynamic import to ensure env vars are set before config loads
        const { createTestServer } = await import('../helpers/test-utils.js');
        
        app = await createTestServer();
        // Clear jobs before start
        await Job.deleteMany({});
    });

    afterAll(async () => {
        if (app) await app.close();
    });

    it('should process a job successfully', async () => {
        const jobType = 'TEST_JOB';
        const jobData = { foo: 'bar' };
        
        let processedJob = null;
        
        // Register handler
        jobQueue.registerHandler(jobType, async (job) => {
            // job object from queue has .data property 
            processedJob = job;
            console.log('Processed Job:', JSON.stringify(job, null, 2));
            return 'success';
        });

        // Register zombie handler to prevent errors in other tests running in parallel/sequence
        jobQueue.registerHandler('ZOMBIE_JOB', async () => {});

        // Add job
        const job = await jobQueue.add({ type: jobType, data: jobData });
        
        // Wait for processing (polling is active)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify DB update
        const completedJob = await Job.findById(job._id);
        expect(completedJob.status).toBe('completed');
        expect(completedJob.completedAt).toBeDefined();

        expect(processedJob).toBeDefined();
        // Accessing data directly from the job object passed to handler
        expect(processedJob.data.foo).toBe('bar');
    });

    it('should recover stale jobs (zombies)', async () => {
        // Create a zombie job stuck in 'processing'
        const zombieJob = await Job.create({
            type: 'ZOMBIE_JOB',
            status: 'processing',
            startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
            attempts: 1
        });

        // Force recovery check
        jobQueue.lastRecoveryCheck = 0; // Reset check timer
        await jobQueue.recoverStaleJobs();

        // Check DB
        const recoveredJob = await Job.findById(zombieJob._id);
        expect(recoveredJob.status).toBe('pending'); // Should be reset to pending
        expect(recoveredJob.error).toBe('Recovered from stale state');
    });

    it('should auto-cleanup old jobs via TTL index', async () => {
        // This tests the Mongoose schema definition, not the actual MongoDB TTL 
        // (which runs in background on DB server)
        const schema = Job.schema;
        const indexes = schema.indexes();
        
        // Find the TTL index
        const ttlIndex = indexes.find(idx => idx[0].completedAt === 1);
        expect(ttlIndex).toBeDefined();
        // Check options for expireAfterSeconds
        // Note: Mongoose stores options in the second array element
        const options = ttlIndex[1];
        expect(options.expireAfterSeconds).toBeDefined();
    });
});
