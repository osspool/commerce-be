import { Repository } from '@classytic/mongokit';
import CrmLossReason, { type ILossReasonDoc } from './loss-reason.model.js';

class CrmLossReasonRepository extends Repository<ILossReasonDoc> {
  constructor() {
    super(CrmLossReason, [], { defaultLimit: 50, maxLimit: 200 });
  }
}

const crmLossReasonRepository = new CrmLossReasonRepository();
export default crmLossReasonRepository;
