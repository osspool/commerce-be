import { BaseController } from '@classytic/arc';
import transactionRepository from './transaction.repository.js';
import { transactionSchemaOptions } from './schemas.js';

/**
 * Transaction Controller
 *
 * Clean controller with validation delegated to repository validators.
 * All business rules are enforced by validationChainPlugin.
 */
class TransactionController extends BaseController {
  constructor() {
    super(transactionRepository, { schemaOptions: transactionSchemaOptions });
  }

  // All CRUD operations now use base controller
  // Validation is handled by transactionValidationPlugin in repository layer
}

export default new TransactionController();
