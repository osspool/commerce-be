import { groups } from './roles.js';

export default {
  list: groups.platformStaff,
  get: groups.platformStaff,
  create: groups.superadminOnly,
  update: groups.superadminOnly,
  remove: groups.superadminOnly,
};

