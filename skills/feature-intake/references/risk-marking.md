# Risk marking

`risk` is data for the people and skills downstream, not a new gate: the implementer still picks its own tier, and the
delivery-orchestrator's holds and safeguards are unchanged. Set it with `fi new --risk` (default `low`); to change it later,
edit the frontmatter line while the spec is a draft (`fi reopen` a ready one first).

| Risk | When | Typical implementer tier |
|---|---|---|
| `low` | contained change, existing pattern, no sensitive data, easy to revert | T0 or T1 |
| `elevated` | several modules, a new pattern, user-visible behaviour change, a performance budget | T2 |
| `high` | authentication or permissions, money, personal data or secrets, a migration or data change, a public API or contract, concurrency | T3 |

When in doubt between two levels, pick the higher one and say why in "Assumptions and unresolved decisions".

## `risk: high` needs a lens note (R7)

"Security and performance" must contain a line starting `Lens:` that records the security or database review done while
writing the spec. It is a short record, not an essay:

```
Lens: security. Export reuses the report's read permission (src/auth/reports.js); no new data leaves the tenant.
Lens: database. Adds a nullable column; backfill is not needed; the migration is reversible.
```

If you cannot complete the review from the code, record what is open as a `[BLOCKING]` decision instead of a vague lens line.

## Things to state for elevated and high risk

- What could go wrong for users or data, and the error scenario (`ER-n`) that covers it.
- Whether the change is reversible, and how (feature flag, migration down step, config).
- Which paths a person should look at in review (the delivery-orchestrator's `hold_paths` decide what it holds; the spec only informs).
