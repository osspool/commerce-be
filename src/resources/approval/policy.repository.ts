import { Repository } from '@classytic/mongokit';
import ApprovalPolicy, { type IApprovalPolicy } from './policy.model.js';

class ApprovalPolicyRepository extends Repository<IApprovalPolicy> {
  constructor() {
    super(ApprovalPolicy, [], {
      defaultLimit: 50,
      maxLimit: 200,
    });
  }

  /**
   * Active policies for a subject, ordered by priority desc. Branch-scoped
   * policies are returned alongside global (`branchId: null`) ones — the
   * resolver picks per match precedence.
   */
  async listActiveForSubject(
    subjectType: string,
    branchId?: string,
  ): Promise<IApprovalPolicy[]> {
    const filter: Record<string, unknown> = {
      subjectType,
      active: true,
    };
    if (branchId) {
      filter.$or = [{ branchId }, { branchId: null }];
    }
    return ApprovalPolicy.find(filter).sort({ priority: -1, updatedAt: -1 }).lean();
  }
}

export const approvalPolicyRepository = new ApprovalPolicyRepository();
export default approvalPolicyRepository;
