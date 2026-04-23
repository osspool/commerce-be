import { Repository } from '@classytic/mongokit';
import CrmAccount, { type IAccountDoc } from './account.model.js';

/**
 * Standard mongokit Repository for `crm_accounts`.
 *
 * Branch scoping is enforced at the HTTP boundary by the per-request adapter
 * (`createAccountRepositoryAdapter`) rather than via `multiTenantPlugin`,
 * because CRM's port does not pass `organizationId` into its method calls.
 * Keeping scoping explicit in the adapter makes the contract obvious.
 */
class CrmAccountRepository extends Repository<IAccountDoc> {
  constructor() {
    super(CrmAccount, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmAccountRepository = new CrmAccountRepository();
export default crmAccountRepository;
