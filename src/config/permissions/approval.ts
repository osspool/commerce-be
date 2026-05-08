/**
 * Approval Permissions
 *
 * Two surfaces:
 *   - `manage`: edit the policy matrix (admin-only — finance/ops sets thresholds)
 *   - `view`:   read policies + preview matches (broad, anyone authenticated
 *               who needs to know what the matrix would do)
 *
 * Subject-side action gates (e.g. "who can submit a PO for approval", "who
 * can decide on a JE chain step") live on the subject's own permission
 * config. This file is only the matrix-management surface — keeping the
 * approval framework's policy editor separate from any subject's gates.
 */

import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, requireAuth } from '#shared/permissions.js';

export interface ApprovalPermissions {
  /** Edit policies (create/update/delete). Platform admin only. */
  manage: PermissionCheck;
  /** Read policies + use /preview. Any authenticated user. */
  view: PermissionCheck;
}

const approval: ApprovalPermissions = {
  manage: platformAdminOnly(),
  view: requireAuth(),
};

export default approval;
