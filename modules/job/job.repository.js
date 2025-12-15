import { Repository } from '@classytic/mongokit';
import Job from './job.model.js';

/**
 * Job Repository
 * Handles job queue data access
 */
class JobRepository extends Repository {
  constructor() {
    super(Job);
  }

  /**
   * Find pending jobs by type
   * @param {string} type - Job type
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Pending jobs
   */
  async findPendingByType(type, options = {}) {
    return this.getByQuery(
      { type, status: 'pending' },
      { sort: { createdAt: 1 }, ...options }
    );
  }

  /**
   * Mark job as started
   * @param {string} jobId - Job ID
   * @param {Object} options - Update options
   * @returns {Promise<Object>} Updated job
   */
  async markAsStarted(jobId, options = {}) {
    return this.update(jobId, {
      status: 'running',
      startedAt: new Date()
    }, options);
  }

  /**
   * Mark job as completed
   * @param {string} jobId - Job ID
   * @param {Object} options - Update options
   * @returns {Promise<Object>} Updated job
   */
  async markAsCompleted(jobId, options = {}) {
    return this.update(jobId, {
      status: 'completed',
      completedAt: new Date(),
      lastRun: new Date()
    }, options);
  }

  /**
   * Mark job as failed
   * @param {string} jobId - Job ID
   * @param {string} error - Error message
   * @param {Object} options - Update options
   * @returns {Promise<Object>} Updated job
   */
  async markAsFailed(jobId, error, options = {}) {
    return this.update(jobId, {
      status: 'failed',
      error,
      completedAt: new Date()
    }, options);
  }
}

const jobRepository = new JobRepository();
export default jobRepository;
