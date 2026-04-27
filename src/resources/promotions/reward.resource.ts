/**
 * Promo Reward Resource — top-level CRUD against `@classytic/promo`'s Reward
 * model. Replaces the old `POST/PUT/DELETE /promotions/programs/:id/rewards*`
 * raw routes (sub-resource hidden inside programResource).
 *
 * Same shape as rule.resource.ts — see that file for rationale.
 * Rewards optionally link to a specific rule (`ruleId`); both filters are
 * exposed so admin UIs can list "rewards for program X" or "rewards
 * triggered by rule Y".
 */
import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import permissions from '#config/permissions.js';
import { ensurePromoEngine } from './promo.plugin.js';

const promoEngine = ensurePromoEngine();

const queryParser = new QueryParser({
  maxLimit: 100,
  allowedFilterFields: ['programId', 'ruleId', 'rewardType'],
  allowedSortFields: ['createdAt', 'updatedAt'],
});

export default defineResource({
  name: 'promo-reward',
  displayName: 'Promo Rewards',
  tag: 'Promotions',
  prefix: '/promotions/rewards',
  tenantField: false,
  adapter: createMongooseAdapter(
    promoEngine.models.Reward as never,
    promoEngine.repositories.reward as never,
  ),
  queryParser,
  permissions: {
    list: permissions.promotions.rewards.list,
    get: permissions.promotions.rewards.get,
    create: permissions.promotions.rewards.create,
    update: permissions.promotions.rewards.update,
    delete: permissions.promotions.rewards.delete,
  },
});
