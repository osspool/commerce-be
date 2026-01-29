import { requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export default {
  purge: requireRoles(groups.superadminOnly),
};
