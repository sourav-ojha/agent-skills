# Software factory roadmap

A personal software factory built from the skills in this repo: a closed loop that turns signals into merged, verified, monitored changes. Humans decide what gets built and how much autonomy the machine has. The machine does the rest inside those limits, spends tokens only where they pay off, and improves from measured runs.

Status: phases 0–2 are to be specified in detail first. Phases 3–8 are outlines, re-specified after Phase 1's benchmark gives real numbers.

## What already exists

| Skill | Role in the factory |
|---|---|
| `product-intelligence` | Understand the repo, research, opportunities, approved feature specs, attention report (`.product/attention.md`) |
| `implementer` | Build a spec with roles chosen by tier (T0–T3), TDD, task ledger, `--unattended` |
| `delivery-orchestrator` | Queue → branch from latest base → implementer → PR → CI → squash merge; project config `.product/delivery.json`; circuit breaker; T3 held unless `--merge-t3` |
| `experience-audit` | Live-app UX and accessibility checks |
| `skill-insights` | Per-skill token cost and errors from transcripts |

## Principles

1. Specs and acceptance scenarios are the human product.
2. The builder never grades its own work.
3. State lives in durable files and git, never in context.
4. Autonomy is a dial per repo and per risk tier. Hard stops are enforced by permissions and sandboxing, not prompts.
5. Every merge carries its evidence: CI, evaluator verdict, tokens, diff summary.
6. Plain files and portable skills. No services unless measurements demand them.
7. Few, high-value tests over many weak ones.
8. Measure first, then strip scaffolding that no longer helps.
9. Budgets are in tokens and turns (subscription-window share once it can be read); dollars are optional.

## Phases

Order follows dependencies: nothing relies on a later phase. Autonomy levels are switched on only when their safety nets exist.

| # | Phase | Spec depth now | Unlocks |
|---|---|---|---|
| 0 | Foundations | Detailed | Everything |
| 1a | Verification gate: driver, isolation, API checks | Detailed | Trustworthy merges for API work; gates `--merge-t3` |
| 1b | Verification gate: UI evaluator | Detailed | Trustworthy merges for UI work |
| 2 | Run control (minimal) | Detailed | Long unattended runs (L0, L1) |
| 3 | Lean test gate | Outline | Fewer, stronger tests |
| 4 | Efficiency | Outline | Lower tokens per merged PR |
| 5 | Design gate | Outline | UI that doesn't look templated |
| 6 | Close the loop and learn | Outline | Auto-revert; L2 |
| 7 | Triage | Outline | Mixed signals become a ranked queue |
| 8 | Full-T3 autonomy and scale-out | Outline | L3; parallel work |

### Phase 0 — Foundations

Spec: [specs/phase-0-foundations.md](specs/phase-0-foundations.md).

Readiness check that outputs a level (0–4), per-check results and a fix list, and gates merging for repos that opt in; run records per feature with token totals joined from transcripts; a spike and classifier for usage-limit detection; a sandbox deny proof delivered as a rerunnable probe.
Exit: see the spec (same level and check results on repeat runs, at least 90% of transcript tokens attributed, both spikes documented with evidence).

### Phase 1 — Verification gate (1a and 1b)

Spec: [specs/phase-1-verification-gate.md](specs/phase-1-verification-gate.md).

A non-LLM factory driver runs builder, scenario author and evaluator as separate sessions under an explicit trust model. Hidden scenarios live outside the repo. API scenarios run as executable checks by the driver (1a); a fresh-context LLM evaluator drives UI scenarios (1b). Anti-gaming checks on the diff, verdicts bound to the merged commit and enforced by a `factory/verified` status, and a seeded benchmark (fixture app; stub, wrong-behaviour, edge, test-edit and isolation cases).
Exit: the spec's 1a and 1b criteria (1a requires every held-out API bad case caught; 1b at least 90% for UI).

### Phase 2 — Run control (minimal)

Spec: [specs/phase-2-run-control.md](specs/phase-2-run-control.md).

Autonomy levels L0 and L1; hard stops backed by real mechanisms; budgets per feature and per day in tokens and turns (window share and dollar caps deferred); interruption handling that commits work and resumes with a continue brief (or `--resume` if Phase 0 proves it), with optional waiting for usage-limit resets (`max_wait_h`, `max_wait_weekly_h`); kill switch checked before every step and every 5 seconds; single-driver lock; attention queue and notifications.
Exit: the spec's criteria, including a usage limit injected at each of four points with no lost work; a feature-cap hit goes to `awaiting_human` (reason `budget`), a day cap pauses the run (kind `day_budget`).

### Phase 3 — Lean test gate (outline)

Keep tests few and strong. Every test is tagged to an acceptance criterion (1–3 per criterion); new tests must fail on the old code and pass on the new; existing tests can't be edited without a written justification. Mutation testing on changed lines, the flake rerun and a small-model test review run nightly or on opt-in, not on every PR, because they need per-language tooling and cost quota. PRs run affected tests; the full suite runs on merge or nightly.
Exit: test count per feature stays within budget, and the revert check catches every seeded test that passes on broken code.

### Phase 4 — Efficiency (outline)

Measure and tune the implementer's existing tier routing and per-stage model choice, using Phase 0's run records. Context hygiene: fresh subagent per task, truncated tool output, cache-stable prompt prefix, minimal-diff rule. Graph or LSP navigation tools only if skill-insights shows navigation cost is high.
Exit: median tokens per merged PR down at least 25% over at least 10 features, with verified-pass rate within 5 points.

### Phase 5 — Design gate (outline)

An anti-slop mode of `experience-audit`, run only when UI files change. Mechanical checks first: a named rule list (overused fonts, purple and gradient text, nested cards, off-token colour and spacing, contrast via axe, overflow at 375/768/1440 px). Then one multimodal critic call on hierarchy, brand fit, distinctiveness and copy. Two revise rounds, then escalate.
Exit: on at least 10 known-slop and 10 known-good pages, with a held-out half, at least 90% are classified correctly.

### Phase 6 — Close the loop and learn (outline)

Post-merge monitoring links regressions to their PR. Auto-revert: flag off first, then revert, freeze the queue until acknowledged; two reverts in 24 hours drop the autonomy level. Factory memory as plain files kept outside the product repo (lessons, decisions, conventions, run history) with evidence-gated writes, last-verified dates and size caps, loaded on demand. skill-insights proposes skill and config changes for human approval, checked against the factory test suite. Enables L2 (deploy plus health checks) for repos that deploy.
Exit: an injected regression is detected and reverted without a human; one loop-proposed change shows a measured improvement.

### Phase 7 — Triage (outline)

A product-intelligence command, not a new skill. Turns bugs, errors, feedback and ideas into scoped, tiered, dependency-ordered queue items. Milestone re-planning is deferred.
Exit: a mixed backlog goes in; a ranked, tiered queue comes out.

### Phase 8 — Full-T3 autonomy and scale-out (outline)

L3 opt-in: typed, per repo, expiring, revocable, recorded outside the repo so the agent can't edit it. T3 evidence before auto-merge: two independent reviews (a second provider via the Codex plugin, or the same model with different prompts if none is available), external scenarios passing, expand-only reversible migrations with a verified snapshot, a default-off feature flag, a blast-radius cap and a dry-run rollback plan. Canary or staging soak only for repos that deploy. One fixed veto window. Parallel worktrees and multi-repo only once serial throughput is the bottleneck.
Exit: a T3 change auto-merges only with full evidence; a seeded unsafe T3 change is refused.

## Metrics

From Phase 0 onward: verified-pass rate, escaped defects per 100 merges, tokens and wall time per merged PR, human minutes per merged PR, seeded-bad catch rate.

## Deferred or cut for a single user

Multi-repo, parallel worktrees, milestone re-planning, canary and contract tests for repos that don't deploy, Serena and Graphify trials, a configurable veto window, memory services, third-party token compressors.

## Process

1. Write a detailed spec for each of phases 0, 1 and 2, in order. Each spec gets an independent review and is iterated until it passes.
2. Write an implementation plan per phase, then build phases 0–2.
3. Re-specify phases 3–8 using Phase 1's benchmark numbers, in the same spec → review → iterate loop.

## Research basis

Summarised from research in Nov 2026: Factory.ai Missions and Software Factory, StrongDM's software factory (external scenarios, digital twins), Anthropic's long-running-agent and harness-design posts (generator/evaluator split, progress files), OpenAI's harness-engineering report, METR and DORA on AI productivity, studies on LLM-written tests and reward hacking, memory and token-compression tools, anti-slop design tools, and safety practices for unreviewed merges. Most outcome evidence in this space is vendor-reported; the thresholds above are starting points to tune from our own run records.
