import { Repository } from '@classytic/mongokit';
import CrmActivity, { type IActivityDoc } from './activity.model.js';

class CrmActivityRepository extends Repository<IActivityDoc> {
  constructor() {
    super(CrmActivity, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmActivityRepository = new CrmActivityRepository();
export default crmActivityRepository;
