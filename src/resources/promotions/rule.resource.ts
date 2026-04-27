/**
 * Promo Rule Resource — top-level CRUD against `@classytic/promo`'s Rule
 * model. Replaces the old `POST/PUT/DELETE /promotions/programs/:id/rules*`
 * raw routes (sub-resource hidden inside programResource).
 *
 * Why top-level: rules are first-class entities with their own `programId`
 * foreign key — Arc handles the filter via `queryParser` (`?programId=...`)
 * and auto-generates list/get/create/update/delete through the adapter.
 * Stays company-wide (`tenantField: false`) because promo is single-tenant
 * multi-branch — same as programResource and voucherResource.
 *
 * Composite views (e.g. `GET /promotions/programs/:id/full` which bundles
 * rules + rewards) stay in promo.resources.ts and query the rule/reward
 * repositories directly.
 */
import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import permissions from '#config/permissions.js';
import { ensurePromoEngine } from './promo.plugin.js';

const promoEngine = ensurePromoEngine();

const queryParser = new QueryParser({
  maxLimit: 100,
  // `programId` is the dominant filter. `code` is sparse-indexed on the
  // schema so listing-by-code is occasionally useful (admin search).
  allowedFilterFields: ['programId', 'code'],
  allowedSortFields: ['createdAt', 'updatedAt'],
});

export default defineResource({
  name: 'promo-rule',
  displayName: 'Promo Rules',
  tag: 'Promotions',
  prefix: '/promotions/rules',
  tenantField: false,
  adapter: createMongooseAdapter(
    promoEngine.models.Rule as never,
    promoEngine.repositories.rule as never,
  ),
  queryParser,
  permissions: {
    list: permissions.promotions.rules.list,
    get: permissions.promotions.rules.get,
    create: permissions.promotions.rules.create,
    update: permissions.promotions.rules.update,
    delete: permissions.promotions.rules.delete,
  },
});
