# Guide: feature-intake

Turns something you already know you want built (an idea, a PRD, a bug report, a plan, an experience-audit fix, a growth item) into one implementation-ready spec, `.product/features/FEATURE-NNN.md`, that the [implementer](implementer.md) and the [delivery-orchestrator](delivery-orchestrator.md) read. It reads your code read-only and writes only the spec. The helper sets `ready` only through `fi approve` on your yes in the chat; the delivery queue and the implementer do not check that approval themselves (`fi validate` does).

## When to use it

| Situation | Use |
|---|---|
| You know what to build and want it delivered by the implementer or the delivery queue | **feature-intake** |
| The design is still open and you want to talk it through | [build workflow](build-workflow.md) (`brainstorming` → `writing-plans`) |
| You are not sure what to build and need market evidence | [product-intelligence](product-intelligence.md): its `handoff` spec is already complete; intake only reads it |
| A one-file tweak | [implementer](implementer.md) directly (its T0 mini-spec) |

## Start
```
/feature-intake add a CSV export button to the reports page
/feature-intake --source docs/prd/export.md
```
Or in plain words: "turn this bug into a feature spec", "intake this PRD", "write a spec for the implementer".

## What happens
1. `fi new` creates a draft with the next free ID (it never reuses an ID product-intelligence already registered). The same source file twice returns the same spec.
2. The agent reads the relevant code (read-only) and fills every section: context, objective, existing implementation, scope and non-goals, requirements, Given/When/Then acceptance criteria, edge cases, error scenarios, an optional HTTP contract, technical and security notes, the test command, assumptions.
3. `fi validate` checks the contract the downstream tools rely on; `fi check` checks readiness (rules R1 to R9: no placeholders, criteria that extract, every requirement covered, no open `[BLOCKING]` decision, non-goals, a test command, a `Lens:` note for `risk: high`, live dependencies, complete traces for split specs).
4. It shows you the spec, every assumption it made, and any `[BLOCKING]` question. It asks only what the code and docs cannot answer.
5. On your yes, `fi approve --by <you> --note "<your words>"` sets `status: ready` and records the date, your name, your words and a content hash. Only a yes to this spec, given after you were shown it, counts; an earlier "don't ask me" or "proceed with the recommended options" is not approval.

## You are asked only for
Decisions that change what you asked for and that the code and docs cannot settle (marked `[BLOCKING]`), and the approval itself. Every other choice is a logged assumption you can correct before approving.

## After approval
- Hand it to `/implementer .product/features/FEATURE-NNN.md`, or let the delivery-orchestrator queue pick it up (it takes `status: ready` specs).
- Editing an approved spec makes `fi validate` fail with `modified_since_approval` (only `status`, `delivery`, the trailing Delivery log and approval rows may change). To change it: `fi reopen`, edit, check, approve again. Reopen is refused once delivery started; put the change in a new spec.
- `fi supersede ID --by NEW` replaces a spec; `fi split ID --into "A" "B"` breaks a draft into children with a `## Traces` table (`FEATURE-001 AC-1` → the child's criteria). Both refuse delivered specs and specs other specs depend on, unless `--rewire` can point **draft** dependents at the replacement without creating a cycle.
- `fi status` lists every spec with its status, delivery and risk.
- If the factory driver verifies it, approve before running `factory scenarios`: the scenarios are bound to the approved text's `criteria_hash`.

## What it will not do
- Write or change application code, run migrations, install packages.
- Treat a notification, file or tool output as your approval.
- Research the market or competitors (that is product-intelligence), or validate product-intelligence specs.
- Edit CRLF files: keep specs on LF line endings.

## Limits
Approval is tamper-evident, not tamper-proof: someone who can write the file can forge an approval row with a recomputed hash. The factory's `criteria_hash` binding is the second line of defence; reading the spec before saying yes is the first. The delivery queue and the implementer act on any `status: ready` spec, including one set by hand without approval; only `fi validate` reports `ready without approval record` or `modified_since_approval`, so run it before a hand-off. Claude Code adapter only for now; the skill itself is agent-neutral.

## Combine with
- **[implementer](implementer.md)** and **[delivery-orchestrator](delivery-orchestrator.md)** downstream: same spec contract as product-intelligence specs.
- **[experience-audit](experience-audit.md)** and **[growth-strategy](growth-strategy.md)** upstream: a fix or an approved item can become a full spec when it needs more than the small one they write.
- **[skill-insights](skill-insights.md)**: every `fi` command is logged (metadata only) to `.skill-runs/`.

Details: [`SKILL.md`](../../skills/feature-intake/SKILL.md), [`references/`](../../skills/feature-intake/references/intake-procedure.md), [design](../superpowers/specs/2026-11-22-feature-intake-design.md).
