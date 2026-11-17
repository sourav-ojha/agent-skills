# Guide: product-intelligence

Decides *what* to build. Read-only on your code; writes only under `.product/`. Reference material (artifacts, configuration, helper CLI): [../usage.md](../usage.md).

## When to use it
- You have a product and want to know where it is weak, what competitors do, and what to build next.
- You want feature specs an implementation agent can consume without inventing requirements.
- Not for: building anything (use [implementer](implementer.md)), or one-off questions about code.

## Start
```
/product-intelligence init              # Claude Code
$product-intelligence init              # Codex
"Understand this product and who the competitors are"   # plain text
```

## The flow (every arrow that says "you" is a stop)

```
init ─► you approve the product baseline ─► research ─► opportunities ─► you decide ─► handoff (specs)
                                                 ▲
                                    refresh / widen (later runs)
```

| Command | Use it for |
|---|---|
| `init` | First run: drafts `.product/PRODUCT.md` from the repo; you correct and approve it |
| `research` | Competitors, open source, emerging and adjacent players, with cited sources |
| `opportunities` | Scored, independently reviewed shortlist; you approve / reject / defer / ask for more research / modify |
| `feature <idea>` | Test one idea you already have through the same pipeline |
| `refresh` | Only what changed since the last run |
| `handoff` | 19-section specs, only for approved opportunities |
| `full` | All of the above, pausing at each gate |

## Getting more ideas (modifiers)
Put these after the command: `research widen`, `full override`, `full auto widen override`.

| Modifier | Effect |
|---|---|
| `widen` | Deeper and broader: more competitors, new source types, a second discovery pass. More candidates are *examined*; the admission test and confidence caps do not change, so weak ideas are not padded in. |
| `override` | Rerun even if the work already ran recently. Approvals and past decisions are kept. |
| `auto` (with `full`) | Unattended. A confidence review after each phase, items needing you go to `.product/attention.md`, the product baseline is approved by recorded delegation, and the run stops **once** at the end with a decision sheet. Opportunity decisions are never delegated. |

"It said it already ran today" is not a limit: say `widen` or `override`.

## What you get
`.product/PRODUCT.md` (approved baseline), `.product/opportunities.md` (landscape, registry, decision log), `.product/features/FEATURE-NNN.md` (specs), and with `auto`, `.product/attention.md`.

## Combine with
- **[implementer](implementer.md)**: give it a spec with status Ready for Implementation. It writes delivery back to the spec and moves it to Implemented.
- **[autonomy-and-memory](autonomy-and-memory.md)**: `full auto` is this skill's own unattended mode; the generic `autonomous` skill is for other work.
- **[skill-insights](skill-insights.md)**: measure what a run cost.

## Limits
Gates are tamper-evident, not tamper-proof: an agent with a shell could run the helper commands, so your chat decision is the real gate. Market claims need web access; without it they are marked `unknown`. Nothing runs in the background.

Deep dive: [../architecture.md](../architecture.md), [`references/run-modes.md`](../../skills/product-intelligence/references/run-modes.md).
