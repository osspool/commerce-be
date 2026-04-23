import { Repository, requireField, validationChainPlugin } from '@classytic/mongokit';
import type { IStockRequest } from './models/stock-request.model.js';
import StockRequest from './models/stock-request.model.js';

/**
 * Stock Request Repository
 *
 * MongoKit repository for stock request queries and validation.
 */
class StockRequestRepository extends Repository<IStockRequest> {
  constructor() {
    super(
      StockRequest,
      [
        validationChainPlugin([
          requireField('requestNumber', ['create']),
          requireField('requestingBranch', ['create']),
          requireField('fulfillingBranch', ['create']),
          requireField('items', ['create']),
          requireField('requestedBy', ['create']),
        ]),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }
}

export default new StockRequestRepository();
