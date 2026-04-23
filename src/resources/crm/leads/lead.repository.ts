import { Repository } from '@classytic/mongokit';
import CrmLead, { type ILeadDoc } from './lead.model.js';

class CrmLeadRepository extends Repository<ILeadDoc> {
  constructor() {
    super(CrmLead, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmLeadRepository = new CrmLeadRepository();
export default crmLeadRepository;
