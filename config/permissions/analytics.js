import { requireAuth } from '@classytic/arc/permissions';

export default {
  overview: requireAuth(),
};
