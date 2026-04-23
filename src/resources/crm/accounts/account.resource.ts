/**
 * CRM Account resource — B2B companies the business sells to.
 *
 * Standard Arc pattern (auto CRUD via adapter). No need for custom actions:
 * the state machine bits live in the CRM package services (lead / opportunity
 * transitions) and are exposed via those resources, not Account.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import CrmAccount from './account.model.js';
import crmAccountRepository from './account.repository.js';

const crmAccountResource = defineResource({
  name: 'crm-account',
  displayName: 'CRM Accounts',
  tag: 'CRM',
  prefix: '/crm/accounts',
  audit: true,

  adapter: createAdapter(CrmAccount, crmAccountRepository),
  presets: [orgScoped],

  // `organizationId` is injected by the orgScoped preset post-validation —
  // drop it from the Arc-generated write schema so clients don't need to
  // echo back what they already sent in the `x-organization-id` header.
  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['name', 'domain', 'industry', 'ownerId', 'tags'],
  }),

  permissions: crmPermissions.account as unknown as Record<string, unknown>,
});

export default crmAccountResource;
