// src/modules/job/JobQueue.js
import EventEmitter from 'events';
import Job from './job.model.js';

class GeneralJobQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.running = false;
        this.jobHandlers = new Map();
        
        this.on('process', this.processNext.bind(this));
        this.on('completed', this.handleCompleted.bind(this));
    }

    registerHandler(jobType, handler) {
        this.jobHandlers.set(jobType, handler);
    }

    add(job) {
        this.queue.push(job);
        if (!this.running) {
            this.emit('process');
        }
    }

    async processNext() {
        if (this.queue.length === 0) {
            this.running = false;
            return;
        }

        this.running = true;
        const job = this.queue[0];

        try {
            // Update job status to processing
            await Job.findByIdAndUpdate(job.jobId, {
                status: 'processing',
                startedAt: new Date()
            });

            const handler = this.jobHandlers.get(job.type);
            if (!handler) {
                throw new Error(`No handler registered for job type: ${job.type}`);
            }

            // Execute the job
            await handler(job);

            // Update job status to completed
            await Job.findByIdAndUpdate(job.jobId, {
                status: 'completed',
                completedAt: new Date()
            });

            this.emit('completed', job);
        } catch (error) {
            console.error(`Job ${job.jobId} failed:`, error);
            await Job.findByIdAndUpdate(job.jobId, {
                status: 'failed',
                error: error.message
            });
        } finally {
            // Cleanup if needed
            if (job.cleanup) {
                await job.cleanup();
            }
            this.queue.shift();
            this.emit('process');
        }
    }

    handleCompleted(job) {
        console.log(`Job ${job.jobId} (${job.type}) completed successfully`);
    }
}

// Create a singleton instance
export const jobQueue = new GeneralJobQueue();