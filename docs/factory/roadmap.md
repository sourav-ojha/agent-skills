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
9. Budgets are in tokens, turns and subscription-window share; dollars are optional.

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

Goal: know whether a repo can be worked unattended, and have the plumbing every later phase measures with.

Scope:
- **Readiness check:** scores one start command, logs on disk, seed or mock data, a runnable test suite with affected-test selection, CI present, branch protection, config present. Outputs a score and a fix list. The orchestrator refuses unattended runs below a configurable minimum.
- **Run record:** one line per feature in a run log: tier, tokens, turns, wall time, verdicts, fix rounds, merge result, skill versions (from `skills.lock.json`). This is the baseline for every later metric.
- **Spike — limit detection:** confirm how the installed Claude Code reports a usage-limit hit (exit code, JSON fields, `rate_limit_event`, `CLAUDE_CODE_RETRY_WATCHDOG` under `-p`).
- **Spike — sandbox deny proof:** show that a builder session cannot read a denied path by any route (Read, Bash `cat`, subagents).

Exit:
- Tested on 3 real repos (one ready, two not). Running twice gives the same score. Each fix item maps to a check that flips after the fix.
- Run records appear for every feature and agree with skill-insights within 10%.
- Both spikes produce a written answer with evidence.

### Phase 1 — Verification gate (the core bet)

Goal: merged work is proven by checks the builder can neither see nor edit.

Scope:
- **External scenarios:** acceptance scenarios written at spec time and stored outside the repo and worktree (for example `~/.factory/scenarios/<repo>/`). The builder runs with sandbox deny rules on that path; only the evaluator process mounts it. A diff check is a backstop, not the control.
- **Evaluator:** fresh context, skeptical prompt. Starts the app with seed or mock environment only (no real credentials, no network beyond localhost), drives each scenario through browser, CLI or API, and returns a verdict with evidence. App output, DOM and logs are treated as untrusted input. Leftover processes are killed on timeout.
- **Anti-gaming checks:** flag edited or deleted tests, stubs, `skip`/`only`, and gaps between visible and held-out results.
- **Orchestrator gate:** the evaluator verdict becomes a required gate beside CI; failures feed the existing fix rounds. `--merge-t3` / `merge.allow_tier3` also requires a passing verdict.
- **Factory test suite:** a seeded-bad benchmark (stubs, test edits, wrong behaviour, off-by-one) plus 5–10 past tasks. It reruns whenever a skill or model changes.

Exit:
- At least 20 seeded-bad cases across the 4 categories: catch rate at least 90%.
- At least 10 known-good implementations: false rejects at most 10%.
- The evaluator uses at most 30% of the tokens per feature.
- Two runs agree on at least 90% of verdicts.

### Phase 2 — Run control (minimal)

Goal: long unattended runs that stay inside user-set limits and survive interruptions.

Scope:
- **Autonomy levels:** ship L0 (supervised) and L1 (merge on green). L2 is enabled at the end of Phase 6 and L3 at the end of Phase 8.
- **Hard stops at every level:** secrets and production credentials, destructive data operations, billing/IAM/security settings, disabling CI or branch protection or the audit log, editing the autonomy config. Enforced by permissions and sandbox rules.
- **Budgets:** tokens and turns per feature, run and day, and share of the 5-hour window. Optional dollar caps.
- **Wait and resume:** `wait_for_reset` (default off), `max_wait`, `max_wait_weekly` (default stop and notify). On a limit hit: write state atomically, sleep in wall-clock slices, keep the machine awake, probe after the reset plus jitter, resume the session with the same flags. A lost session re-queues the task; commits are never lost.
- **Kill switch:** a file flag checked on every orchestrator call and between implementer tasks.
- **Attention queue:** reuse the `.product/attention.md` pattern.

Exit:
- The kill switch halts within 60 seconds or one helper call.
- An injected limit hit resumes from the same state with zero lost commits, 3 out of 3 trials.
- An over-budget run stops as `paused_budget` with an attention-queue entry.

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
