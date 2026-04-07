import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface NotificationPermissions {
  /** List own notifications */
  view: PermissionCheck;
  /** SSE real-time stream */
  stream: PermissionCheck;
  /** Broadcast / admin config */
  manage: PermissionCheck;
}

const notifications: NotificationPermissions = {
  view: requireAuth(),
  stream: requireAuth(),
  manage: requireRoles(groups.platformAdmin),
};

export default notifications;
