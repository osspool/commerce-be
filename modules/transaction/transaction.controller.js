import BaseController from '#common/controllers/baseController.js';
import transactionRepository from './transaction.repository.js';
import { transactionSchemaOptions } from './schemas.js';

/**
 * Transaction Controller
 *
 * Clean controller with validation delegated to repository validators.
 * All business rules are enforced by validationChainPlugin.
 *
 * Flexible querying enabled:
 * - systemManaged fields (gateway, webhook, commission) automatically blocked
 * - Supports select, populate, filter, sort, pagination via query params
 *
 * Validation is centralized in: validators/transaction.validators.js
 */
class TransactionController extends BaseController {
  constructor() {
    super(transactionRepository, transactionSchemaOptions);
  }

  // All CRUD operations now use base controller
  // Validation is handled by transactionValidationPlugin in repository layer
  // This eliminates 100+ lines of scattered validation logic
}

export default new TransactionController();
