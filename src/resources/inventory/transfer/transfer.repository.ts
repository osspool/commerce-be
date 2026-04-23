import { Repository, requireField, validationChainPlugin } from '@classytic/mongokit';
import type { ITransfer } from './models/transfer.model.js';
import Transfer from './models/transfer.model.js';

/**
 * Transfer Repository
 *
 * Thin extension of mongokit's `Repository` — only adds field-presence
 * validation on create. List / get / count / by-status queries flow
 * through Arc's `BaseController` + `repository.getAll(...)` so callers
 * compose filters as standard query params (`?status=approved&page=2`).
 */
class TransferRepository extends Repository<ITransfer> {
  constructor() {
    super(
      Transfer,
      [
        validationChainPlugin([
          requireField('senderBranch', ['create']),
          requireField('receiverBranch', ['create']),
          requireField('items', ['create']),
          requireField('createdBy', ['create']),
        ]),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }
}

export default new TransferRepository();
