# Guide: implementer

Delivers a feature on a feature branch with test-driven development, acceptance criteria, a tracked task ledger and recorded evidence. It never pushes, merges or opens a PR unless you ask in that run. Claude Code only for now.

## When to use it
- You have a spec (for example a `FEATURE-NNN.md` from [product-intelligence](product-intelligence.md)) or a raw idea to build.
- Not for: choosing what to build, or reviewing someone else's PR (see [review-and-quality](review-and-quality.md)).
- Alternative when the design is still open: the [build workflow](build-workflow.md).

## Start
```
/implementer .product/features/FEATURE-001.md
/implementer add a CSV export button to the reports page
```
Flags: `--no-tdd` (skip test-first, logged as a ruling) and `--pr` (allow it to open a PR at the end).

A raw idea becomes a one-page mini-spec (goal, Given/When/Then criteria, non-goals) that you approve before any planning.

## How it sizes the work

| Tier | Work | What runs |
|---|---|---|
| T0 | one-file tweak | the lead alone, then verify |
| T1 | small contained change | engineer, then verify |
| T2 | normal feature | [architect] → engineers → QA → reviewer |
| T3 | auth, data, migrations, public API | adds an architect and a security/database lens |

For T2/T3 it shows the task plan and **waits for your approval**. Independent tasks that own different files run in parallel worktrees (up to 4); tasks sharing files run in sequence. Only QA marks a task passed, with a command and exit code.

## You are asked only for
Destructive operations, security-sensitive actions, pushes/merges/deploys, a spec conflict it cannot resolve, a task blocked after 3 fix rounds, and anything that would change what you asked for. Everything else is decided, logged as a ruling, and listed at sign-off.

## What you get
- Commits on a feature branch, one per task.
- `.implementation/<slug>/` (task ledger and decision log; never committed).
- The spec updated: a `## Delivery log` row, `delivery:` frontmatter, and `Implemented` status only when every criterion is delivered.
- A closing report: what changed, evidence, tests added or removed and why, rulings, what is not done or not verified, and the exact next step.
- A run record in `.skill-runs/` (what was unclear, skipped, improvised, one suggested improvement) for [skill-insights](skill-insights.md).

## Combine with
- **[product-intelligence](product-intelligence.md)** upstream: specs in, delivery status out.
- **[review-and-quality](review-and-quality.md)** downstream: `/deep-pr-review` once you open the PR.
- **[skill-insights](skill-insights.md)**: `si export` packages the run for review.
- It applies the same test-first discipline as `test-driven-development` and the same "evidence before claims" rule as `verification-before-completion`, built in.

## If it stops with "impl helper not found"
The helper lives inside the installed skill folder, not your project. Reinstall with `npx skills add sourav-ojha/agent-skills --skill implementer -a claude-code`. For T2/T3 it stops rather than run without the ledger.

Details: [`adapters/claude-code/README.md`](../../skills/implementer/adapters/claude-code/README.md), [design spec](../superpowers/specs/2026-11-17-implementer-design.md).
