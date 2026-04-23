import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, requireAuth } from '#shared/permissions.js';

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
  manage: platformAdminOnly(),
};

export default notifications;
