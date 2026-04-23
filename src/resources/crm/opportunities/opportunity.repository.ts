import { Repository } from '@classytic/mongokit';
import CrmOpportunity, { type IOpportunityDoc } from './opportunity.model.js';

class CrmOpportunityRepository extends Repository<IOpportunityDoc> {
  constructor() {
    super(CrmOpportunity, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmOpportunityRepository = new CrmOpportunityRepository();
export default crmOpportunityRepository;
