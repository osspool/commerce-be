import { groups } from './roles.js';

export default {
  getConfig: [],
  updateConfig: groups.adminOnly,
};

