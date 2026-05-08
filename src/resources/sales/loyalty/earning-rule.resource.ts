/**
 * Loyalty Earning Rules Resource — modern Arc adapter + actions.
 *
 * Auto-CRUD via mongokit adapter (list/get/create/update/delete).
 * Declarative `actions:` for FSM verbs (deactivate). No raw routes.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import type { RequestWithExtras } from '@classytic/arc/types';
import permissions from '#config/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';

const engine = await ensureLoyaltyEngine();

const earningRuleResource = defineResource({
  name: 'loyalty-earning-rule',
  displayName: 'Earning Rules',
  tag: 'Loyalty',
  prefix: '/loyalty/earning-rules',
  audit: true,

  // Loyalty is company-wide by design (see loyalty.plugin.ts) — one program,
  // one set of earning rules across every branch, matching Sephora / Nike /
  // Starbucks loyalty architecture. `tenantField: false` keeps Arc's adapter
  // from injecting an `organizationId` filter on reads. Docs are still
  // stamped with `organizationId` (which branch enrolled the rule) for
  // audit, but the rule applies globally.
  tenantField: false,

  adapter: createMongooseAdapter(engine.models.EarningRule as never, engine.repositories.earningRule as never),
  queryParser,

  permissions: {
    list: permissions.loyalty.view,
    get: permissions.loyalty.view,
    create: permissions.loyalty.manage,
    update: permissions.loyalty.manage,
    delete: permissions.loyalty.manage,
  },

  actions: {
    /** Pause an active rule without deleting it. */
    deactivate: {
      handler: async (id: string, _data: Record<string, unknown>, _req: RequestWithExtras) => {
        return engine.repositories.earningRule.update(id, { status: 'paused' });
      },
      permissions: permissions.loyalty.manage,
    },

    /** Resume a paused rule. */
    activate: {
      handler: async (id: string, _data: Record<string, unknown>, _req: RequestWithExtras) => {
        return engine.repositories.earningRule.update(id, { status: 'active' });
      },
      permissions: permissions.loyalty.manage,
    },
  },
});

export default earningRuleResource;
