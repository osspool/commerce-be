import { Repository } from '@classytic/mongokit';
import CrmPipeline, { type IPipelineDoc } from './pipeline.model.js';

class CrmPipelineRepository extends Repository<IPipelineDoc> {
  constructor() {
    super(CrmPipeline, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmPipelineRepository = new CrmPipelineRepository();
export default crmPipelineRepository;
