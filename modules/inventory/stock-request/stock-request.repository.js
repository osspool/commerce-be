import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import StockRequest from './models/stock-request.model.js';

/**
 * Stock Request Repository
 *
 * MongoKit repository for stock request queries and validation.
 */
class StockRequestRepository extends Repository {
  constructor() {
    super(StockRequest, [
      validationChainPlugin([
        requireField('requestNumber', ['create']),
        requireField('requestingBranch', ['create']),
        requireField('fulfillingBranch', ['create']),
        requireField('items', ['create']),
        requireField('requestedBy', ['create']),
      ]),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }
}

export default new StockRequestRepository();
