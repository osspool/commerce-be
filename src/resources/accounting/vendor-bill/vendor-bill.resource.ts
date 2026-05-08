/**
 * Vendor Bills Resource — A/P view over JournalEntry, account 2111.
 *
 * Mirror of customer-invoice — same filtering, schema, /open scaffolding,
 * action-only writes — produced by the shared factory. See
 * `_shared/control-account-resource.factory.ts` for the full contract.
 *
 * Vendor bills are not a separate model — they are JournalEntry docs whose
 * journalItems carry a partnerId on the A/P control account. Writes flow
 * exclusively through declarative `actions` (post / pay / credit-note).
 */

import { defineControlAccountResource } from '../_shared/control-account-resource.factory.js';
import {
  vendorBillActionPermissions,
  vendorBillActions,
} from './vendor-bill.actions.js';

const vendorBillResource = defineControlAccountResource({
  side: 'payable',
  controlCode: '2111',
  partnerType: 'supplier',
  partnerQueryKey: 'supplierId',

  name: 'vendor-bill',
  displayName: 'Vendor Bills',
  tag: 'Accounting - Vendor Bills (A/P)',
  prefix: '/accounting/vendor-bills',

  actions: vendorBillActions,
  actionPermissions: vendorBillActionPermissions,
});

export default vendorBillResource;
