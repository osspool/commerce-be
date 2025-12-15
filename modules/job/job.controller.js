import BaseController from '#common/controllers/baseController.js';
import jobRepository from './job.repository.js';
import { jobSchemaOptions } from './schemas.js';

/**
 * Job Controller
 * Handles job queue CRUD operations
 *
 * Note: Jobs are typically created by system processes
 * This controller is mainly for viewing and monitoring job status
 */
export class JobController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, schemaOptions);
  }
}

const jobController = new JobController(jobRepository, jobSchemaOptions);
export default jobController;
