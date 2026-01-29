import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export const cms = {
  get: allowPublic(),
  create: requireRoles(groups.adminOnly),
  update: requireRoles(groups.adminOnly),
  delete: requireRoles(groups.adminOnly),
};

export const media = {
  list: requireRoles(groups.adminOnly),
  get: requireRoles(groups.adminOnly),
  update: requireRoles(groups.adminOnly),
  delete: requireRoles(groups.adminOnly),
  manage: requireRoles(groups.adminOnly),
};

export default { cms, media };
