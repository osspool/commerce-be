import { groups } from './roles.js';

export default {
  list: groups.authenticated,
  get: groups.authenticated,
  create: [],
  update: groups.authenticated,
  remove: groups.platformStaff,
  me: groups.userOrAdmin,
};
