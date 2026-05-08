# be-prod wiki

Map of how subsystems wire up. **Every claim links to a file.** No prose, no
duplication, no narrative — just flows + file refs so a future agent (or human)
can navigate without re-reading the codebase.

## Conventions

- One folder per subsystem (`order/`, `pos/`, `accounting/`, …). Add yours when you work on it.
- Each file is a single flow / single concern. Keep it under 60 lines.
- Format: a short blurb, an ASCII flow with `file:line` anchors, then a "files" table.
- Cross-link via relative markdown: `[place](order/place.md)`.
- Update when the linked code changes. If you can't, leave a `<!-- STALE: <date> -->` marker.

## Subsystems

- [order/](order/) — order lifecycle, RMA, refund, fulfillment money flow

(append your subsystem here)
