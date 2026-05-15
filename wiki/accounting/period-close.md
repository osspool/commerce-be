# Period close

5-step wizard with per-step approval gating. The whole flow runs through
ONE action endpoint — each `advance` call moves to the next step.

```
POST /accounting/period-close { periodId, branchScope? }              period-close.resource.ts (CRUD via adapter)
  → creates PeriodCloseSession {status: 'in_progress', steps: [...]}
  → first step (`validate`) auto-runs

POST /accounting/period-close/:sessionId/action {action: "advance"}   period-close.resource.ts → advanceSession()
  → requireRoles('admin', 'finance_admin') gate (action-level)
  → reads sessionDoc, finds first non-done step
  → runs that step's handler:
        validate         → period date span + locks check
        trial_balance    → @classytic/ledger.generateTrialBalance()
                            ↳ result persisted to step.result (cache)
        bank_reconcile   → cross-check against bank statements
        close_period     → fiscalPeriod.markClosed(); locks JE posting
        archive          → snapshot BS+P&L+TB into step.result
  → moves to next step
  ← returns updated session

POST /accounting/period-close/:sessionId/action {action: "reopen", reason} period-close.resource.ts
  → requireRoles('admin') — stricter than advance
  → if session.status === 'closed':
        → fiscalPeriod.markOpen(); JE posting re-enabled
        → audit-log the reopen with reason
  ← session.status = 'reopened'
```

## Why "no approval gate" is a FALSE POSITIVE

The gap doc previously claimed `close_period` step needs a separate
approver. The action-level gate `requireRoles('admin', 'finance_admin')`
on `advance` covers EVERY step including the final `close_period`. To
add a stricter gate just for the last step, override the `permissions`
field on a dedicated action — but the existing flow is already
authorization-correct.

## Materialization

Each step writes its full result to `PeriodCloseStepDoc.result` (Mongo
mixed type). That's the "materialized snapshot" — trial balance, balance
sheet summary, P&L, all frozen at close time. No separate snapshot table
needed; the session IS the archive.

See [`period-close.model.ts`](../../src/resources/accounting/period-close/period-close.model.ts) line 54.

## Files

| File | Purpose |
|---|---|
| [period-close.resource.ts](../../src/resources/accounting/period-close/period-close.resource.ts) | resource + advance/reopen actions |
| [period-close.service.ts](../../src/resources/accounting/period-close/period-close.service.ts) | step handlers (validate / trial_balance / bank_reconcile / close_period / archive) |
| [period-close.model.ts](../../src/resources/accounting/period-close/period-close.model.ts) | session + step docs (step.result persists computed snapshots) |

## Gotchas

- **Reopening a closed period is NOT a free undo.** It only re-enables JE
  posting; doesn't reverse the period's JEs. To "unwind" a wrong close,
  reopen + post compensating JEs.
- **Step result caching is per-session.** Closing the same period twice
  produces TWO sessions with TWO snapshot copies. Reports should query
  the LATEST `status: 'closed'` session.
- **`fiscalPeriod.markClosed()` writes to ledger's FiscalPeriod model**,
  which is company-wide (`tenantField: false`). Closing affects ALL
  branches. To close per-branch, use `branchScope` on the session.
