/**
 * Partner Resource — action-only (opening balances, future: credit limits, merges)
 *
 * POST /accounting/partners/:id/action via declarative `actions` block.
 * No CRUD — partners are managed via the customer/supplier modules.
 */
import { defineResource } from '@classytic/arc';
import { partnerActions } from './partner.actions.js';

const partnerResource = defineResource({
  name: 'partner',
  displayName: 'Partners',
  tag: 'Accounting - Partners',
  prefix: '/accounting/partners',
  disableDefaultRoutes: true,
  skipValidation: true,

  actions: partnerActions,
});

export default partnerResource;
