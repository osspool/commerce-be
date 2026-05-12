# Resource manifest — feature → directory mapping

Source: [config/resource-manifest.ts](../../src/config/resource-manifest.ts)
Used by: [create-arc-app-options.ts](../../src/core/app/create-arc-app-options.ts)

`loadResources()` is called **per enabled dir** — disabled features produce zero routes.
Arc skips `null`/`undefined` default exports gracefully (logged as warnings, not fatal).

## Dir → feature table

| Feature trigger                  | Dir(s) loaded                                        |
| -------------------------------- | ---------------------------------------------------- |
| always                           | auth, platform, audit, archive, notifications        |
| always                           | approval, commerce                                   |
| core *(always-on)*               | catalog, sales/cart, sales/customers                 |
| core                             | sales/orders, sales/pricelist, payments, transaction |
| orders                           | sales/blanket-order, sales/rfq, sales/quotations, sales/rma |
| pos                              | sales/pos                                            |
| loyalty                          | sales/loyalty                                        |
| inventory **or** warehouse **or** pos | inventory *(entire dir, all WMS subresources)*  |
| accounting                       | accounting, finance                                  |
| crm                              | crm                                                  |
| analytics                        | analytics, admin                                     |
| cms                              | content                                              |
| logistics                        | logistics                                            |
| promotions                       | promotions                                           |

## Deployment matrix

| Client type        | ENABLED_FEATURES                      | Key dirs loaded (beyond always)              |
| ------------------ | ------------------------------------- | -------------------------------------------- |
| Full commerce      | *(unset → all enterprise)*            | all                                          |
| IT company         | `core,accounting,crm`                 | catalog, sales/orders, accounting, crm       |
| Retail POS         | `core,pos,inventory,loyalty`          | catalog, sales, inventory, pos, loyalty      |
| Headless store     | `core,promotions,logistics`           | catalog, sales/orders, promotions, logistics |
| B2B wholesale      | `core,orders,accounting,logistics`    | catalog, sales, accounting, logistics        |

## Arc loading facts

- `loadResources(dir, { recursive: true })` — default; picks up `*.resource.{ts,js}` only
- `exclude: string[]` / `include: string[]` — exact match on resource `.name`, not globs
- `null` default export → skipped with a warning (does not abort boot)
- Multiple dirs → `Promise.all([...loadResources calls]).then(r => r.flat())`
- `CreateAppOptions.resources` accepts `(fastify) => ResourceLike[]` async factory ✓
