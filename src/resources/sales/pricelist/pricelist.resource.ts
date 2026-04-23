/**
 * Pricelist Resource — Arc auto-CRUD for @classytic/pricelist.
 *
 * Arc generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
 * from the mongokit repository adapter.
 *
 * resolvePrice is called internally by the catalog PricingBridge,
 * not exposed as an HTTP endpoint.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { ensurePricelistEngine } from './pricelist.plugin.js';

// Top-level — mongoose is connected by the time loadResources() runs.
// ensurePricelistEngine() is idempotent (creates once, returns cached).
const engine = ensurePricelistEngine();
const pricelistAdapter = createAdapter(engine.models.PriceList as never, engine.repositories.priceList as never);

export default defineResource({
  name: 'pricelist',
  displayName: 'Price Lists',
  tag: 'Pricing',
  prefix: '/pricelists',
  audit: true,

  adapter: pricelistAdapter,
  queryParser,
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    create: permissions.orders.create,
    update: permissions.orders.update,
    delete: permissions.orders.delete,
  },
});
