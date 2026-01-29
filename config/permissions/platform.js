import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export default {
  getConfig: allowPublic(),
  updateConfig: requireRoles(groups.adminOnly),
};
