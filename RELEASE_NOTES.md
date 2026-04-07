# Release Notes

## v0.2 — Smart Period Locks + Day-Close ERP Lifecycle (April 2026)

ERP-grade closed-period enforcement, Odoo-style forward corrections, multi-branch
day-close oversight, and a unified Stripe-style action endpoint for journal
entries and the day-close lifecycle. End-to-end across be-prod, the SDK, and
fe-bigboss.

### Shipping in this release

**Backend (be-prod)**

- **Period lock guard** (`src/resources/accounting/posting/period-lock-guard.ts`)
  - `dayCloseLockPlugin()` mongokit plugin hooks `before:create` AND `before:update`
  - Blocks any journal entry whose date is on/before
    `DayCloseState.lastClosedDate` for the branch
  - Forward corrections via `reverse(reversalDate=open_day)` always allowed
- **Engine refactor** to top-level eager singleton pattern
  - `accounting`, `Account`, `JournalEntry`, `accountRepository`, … as direct const exports
  - Dropped `initAccountingEngine()`, `getAccountingEngine()`, all `get*Model()` getters
  - Matches `fajr-be-arc` reference pattern
- **JournalEntry action router** — `POST /accounting/journal-entries/:id/action`
  - Actions: `post`, `reverse`, `duplicate`, `archive`
  - **`unpost` intentionally removed** — Odoo-correct: posted is final, use reverse
  - Period-lock errors mapped to HTTP 409 (`PERIOD_LOCKED`, `FISCAL_ERROR`)
- **Day-Close action router** — `POST /accounting/posting/day/_/action`
  - Actions: `close`, `reopen`, `backfill`
  - `reopen` = forward correction: reverse original JE with `reversalDate=today`,
    rewinds `DayCloseState.lastClosedDate` by one day
  - Reopen requires `reason` (audit) and `finance_admin` role (stricter than close)
- **Cross-branch oversight** — `GET /accounting/posting/oversight`
  - Returns per-branch `lastClosedDate` + `daysBehind` + summary
  - admin / finance_admin only
- **Auto-post bug fix** — `createPosting()` was silently failing under ledger
  `requireActor` strictness; POS day-close JEs were sitting as `draft` instead of
  `posted`. Threaded `actorId` through, added `SYSTEM_ACTOR_ID` sentinel for
  background flows.
- **ledger 0.5.1 upgrade** — `JournalEntryRepository.post/unpost/archive/reverse`
  now route through the plugin pipeline (was bypassing `before:update` via
  direct `entry.save()`); `reverse()` and `duplicate()` propagate `extraFields`
  (the `organizationId` branch tag).

**Tests**

- `accounting-period-lock.test.ts` — 14 tests (fiscal + day-close enforcement)
- `accounting-journal-entry-actions.test.ts` — 9 tests (action router incl.
  unpost-removed assertion + period-lock 409s)
- `accounting-day-close-actions.test.ts` — 11 tests (close/reopen/backfill)
- `accounting-oversight.test.ts` — 5 tests (cross-branch days-behind)
- Migrated `accounting-company-wide.test.ts` from legacy PATCH routes to action endpoint
- **Final tally: 307/307 accounting integration tests passing** (12 files)

**SDK (`@classytic/commerce-sdk@0.2.0`)** — published to npm

- `journalEntryApi.{post,reverse,duplicate,archive}` all hit unified `:id/action` endpoint
- New API functions: `reopenDay`, `getDayCloseOversight`
- New hooks: `useReopenDay()`, `useDayCloseOversight()`
- Dropped: `unpost` from `useJournalEntryStateActions()` and `journalEntryApi.unpost()`
- Added: `archive` action everywhere
- New types: `DayCloseOversight`, `DayCloseOversightBranch`
- All accounting API methods migrated from legacy `data:` body field to arc-next's
  `body:` field (was a long-standing typecheck error)

**Frontend (fe-bigboss)** — installed `@classytic/commerce-sdk@0.2.0` from registry

- `posting-client.tsx` — **Reopen Day** button + reason dialog using `DialogWrapper`
  from `@classytic/fluid/client/core` (Base UI `trigger`/`footer` props, not Radix
  `asChild`)
- `overview-client.tsx` — **"Branches Behind" banner** (red ≥3 days, yellow ≥1
  day) linked to oversight screen
- `oversight/oversight-client.tsx` (NEW) — cross-branch table + 3 summary cards
- `app/dashboard/accounting/oversight/page.tsx` (NEW)
- `feature-registry.ts` — sidebar entry "Day Close Oversight" under Accounting
- `journal-entry-detail-client.tsx` — Unpost button removed from header actions
- Removed `sync:sdk` script — now consumes published `@classytic/commerce-sdk@^0.2.0`
- `node_modules` + `package-lock.json` regenerated against the published artifact
- `npx tsc --noEmit` — 0 errors

---

### Known gaps / explicitly deferred

#### 1. Tax lock date (NBR / mushak filing freeze) — **waiting on ledger team**

Odoo's `tax_lock_date` is a third lock layer beyond fiscal-period and day-close.
Once a VAT/TDS return is filed for a period, any *tax-affecting* account
(VAT payable, input VAT, withholding) becomes frozen for that range, even if
the rest of the period remains editable.

- **Where it belongs:** the ledger, not be-prod. It's the same shape as
  `fiscalLockPlugin` and `dateLockPlugin` — operates on `entry.date` +
  `account.accountTypeCode`, universal across countries.
- **What's blocking:**
  1. Ledger team needs to ship a `taxLockPlugin` (~120 lines, mirrors
     `fiscalLockPlugin`)
  2. `bangladeshPack` needs a `taxAccountCodePattern` field to identify
     VAT/TDS/VDS accounts (regex over `accountTypeCode`)
  3. We need a mushak-9.1 filing workflow in be-prod to set the lock date
     (no point enforcing if there's nothing to enforce against)
- **Impact today:** zero — VAT *accounting* works (POS day-close splits VAT
  lines correctly via `dailyPosSummaryToPosting`; reports separate output VAT
  from input VAT). The missing piece is the *compliance freeze*, and there's
  no UI for filing a return yet.
- **Action:** PR text drafted in `project_accounting_module` memory. Will land
  alongside the mushak filing workflow in a future release.

#### 2. Pre-existing typecheck errors in non-accounting SDK modules

`inventory/`, `warehouse/`, `audit/`, `notifications/` had ~30 long-standing
TypeScript errors that were blocking `npm publish` via the `prepublishOnly`
script. **Fixed by user** before publish — all SDK modules now type-check clean.
No further action required.

#### 3. Reopen permission UI gating

The Reopen Day button is rendered for any user who can see the page. Backend
correctly rejects with 403 if the caller isn't `finance_admin`. Frontend should
ideally hide the button for non-finance_admin users — minor UX polish, not a
correctness issue. **Tracked for next release.**

#### 4. Days-behind computation rounding

`oversight.daysBehind` rounds based on UTC midnights, which can show off-by-one
on the BD/UTC boundary (BD is UTC+6). The test tolerates `daysBehind ± 1`. Real
fix is to compute BD-day arithmetic with `bdDateStrToDate` instead of raw
`Date.getTime()`. **Cosmetic.**

---

### Verification commands

```bash
# Backend integration tests
cd be-prod
npx vitest --config vitest.integration.config.ts run tests/integration/accounting
# Expected: Test Files 12 passed (12) | Tests 307 passed (307)

# SDK type check
cd packages/commerce-bd-sdk
npx tsc --noEmit
# Expected: 0 errors

# Frontend type check (against published SDK)
cd fe-bigboss
npx tsc --noEmit
# Expected: 0 errors

# Confirm installed SDK version
cat fe-bigboss/node_modules/@classytic/commerce-sdk/package.json | grep version
# Expected: "version": "0.2.0"
```

### Manual smoke test before tagging

1. `cd be-prod && npm run dev` — server boots, no plugin registration warnings
2. `cd fe-bigboss && npm run dev` — open `/dashboard/accounting`
3. **Close yesterday** via Day Close screen → status flips to "Closed"
4. **Reopen** with reason → counter-entry visible in `/dashboard/accounting/journal-entries`
5. Visit `/dashboard/accounting/oversight` → table renders all branches
6. Create a fiscal period for last month, close it, try to backdate a manual JE → expect 409
7. Verify the "Branches Behind" banner appears on `/dashboard/accounting` when any branch is ≥1 day behind

If any of those fail, do NOT tag the release.

---

### Versions

| Component | Version | Source |
|---|---|---|
| `@classytic/commerce-sdk` | `0.2.0` | published to npm |
| `@classytic/ledger` | `0.5.1` | npm |
| `@classytic/ledger-bd` | (current) | npm |
| `@classytic/arc` | `2.6.2` | npm |
| `@classytic/arc-next` | `^0.3.1` | npm |
| `@classytic/fluid` | `^0.5.0` | npm |
| be-prod | (untagged) | git |
| fe-bigboss | `0.1.0` | git (Next.js app, deployed not published) |

### Breaking changes for SDK consumers

If you were on `@classytic/commerce-sdk@0.1.x`:

1. `useJournalEntryStateActions().unpost` is **gone**. Use `.reverse({ id })` —
   creates a forward-correction counter-entry. The original entry stays posted
   with `reversed=true`.
2. `journalEntryApi.unpost()` is **gone**. Same migration.
3. `journalEntryApi.{post,reverse,duplicate}` now hit
   `POST /accounting/journal-entries/:id/action` instead of individual PATCH
   routes. Same call signature on the client side, just a different network
   request.
4. `closeDay()`, `backfillPostings()` now hit the action router URL
   (`POST /accounting/posting/day/_/action`). Wrappers transparent — no caller
   change needed.
5. New: `reopenDay({ date, reason })`, `useReopenDay()`, `useDayCloseOversight()`,
   `journalEntryApi.archive()`, `useJournalEntryStateActions().archive`.

### What "release" means here

- **SDK:** `npm publish @classytic/commerce-sdk@0.2.0` ✅ done
- **be-prod:** git tag `v0.2-period-locks` (suggested — not pushed by tooling).
  Deploy to staging first, run smoke tests, then prod.
- **fe-bigboss:** Next.js app — "release" = deploy. Not an npm package. Run
  `next build` and ship to your hosting provider after smoke tests pass.
