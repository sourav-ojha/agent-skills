# Guide: delivery-orchestrator

Takes every ready feature spec and delivers them one by one without you: **branch → [implementer](implementer.md) → PR → wait for CI → squash merge → next**. It is the hands-off end of the pipeline that starts with [product-intelligence](product-intelligence.md).

## When to use it
- You have several specs with `status: ready` (what product-intelligence `handoff` writes) and want them built, reviewed by CI and merged without babysitting.
- Not for: one feature you want to watch (use [implementer](implementer.md)), or designs that are still open (see [build-workflow](build-workflow.md)).

## Before you start
- The GitHub CLI is logged in (`gh auth status`) and the repo has a GitHub remote.
- Both skills are installed: `npx skills add sourav-ojha/agent-skills --skill delivery-orchestrator -a claude-code` and `--skill implementer`.
- **The repo has CI that runs your tests**, and the base branch ideally *requires* it (branch protection). If the only checks that ran are a linter or secret scanner, the run stops and tells you which checks it saw: pass `--checks "<your test check>"`. (`--no-ci` accepts the implementer's local test evidence instead; it is never implied.)
- Ideally the base branch is protected (required checks, and required reviews where you want a person). That, not this skill, is the real gate.

## Start small
```
/delivery-orchestrator --dry-run        # show the queue, change nothing
/delivery-orchestrator --limit 1        # one feature, PR only, no merge
/delivery-orchestrator --merge          # authorise squash merges for the queue
```
In plain words: "deliver all the ready features and merge each when CI is green". It passes `--merge` only if you asked it to merge, and records your words.

## What happens for each feature
1. The base branch is updated and `feat/<id>-<slug>` is created.
2. The implementer builds it (`--unattended`: nothing waits for you; a question only a person can answer ends that feature as `BLOCKED`).
3. A PR is opened (pushed without force).
4. It waits for CI. A failing check gets up to 2 fix rounds (test first), then the feature is blocked.
5. It squash-merges **the exact commit CI verified** and syncs the base.
6. Next feature. A feature whose dependency did not merge is skipped, not built on a missing base.

Order: `depends_on: FEATURE-001, FEATURE-002` in a spec's frontmatter, then by id.

## What it holds for you instead of merging
- T3 work (auth, data, migrations, public API) unless you pass `--merge-t3`.
- Any change touching `.github/`, other CI config or `CODEOWNERS`.
- Anything branch protection or a required review blocks.
- All of it if you did not pass `--merge`.

It also stops the whole run on: no verified test check (see above), two blocked features in a row, a base branch that cannot be fast-forwarded.

## What you get
A final report: merged features (PR and sha), PRs waiting for you (and why), blocked or skipped features (and where the partial work is: a branch plus `git stash list`), and non-code follow-ups from the specs' delivery logs.

## Interrupted? Resume
State is in `.delivery/queue.json`. Say "continue the delivery run" in any session: it resumes the active feature. `deliver status` shows everything.

## Combine with
- **[product-intelligence](product-intelligence.md)** upstream (specs); **[implementer](implementer.md)** does the coding; **[review-and-quality](review-and-quality.md)** for a deeper review of any held PR (`/deep-pr-review`); **[skill-insights](skill-insights.md)** to see what a long run cost.

Safety model and its limits: [`references/safety.md`](../../skills/delivery-orchestrator/references/safety.md). State machine: [`references/states.md`](../../skills/delivery-orchestrator/references/states.md).
