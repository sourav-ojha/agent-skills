# Implementer skill: design

Status: draft for approval. Nothing is built until this is approved.

## Intent
A second, independently installable skill (`skills/implementer`) that turns an approved spec or a raw idea into reviewed, tested, committed code, using only the expert roles the work needs. It must be cheap in tokens and files, track progress, and run independent tasks in parallel.

## Goals
- Works from a product-intelligence spec (`FEATURE-NNN.md`, status Ready for Implementation) or from a raw idea (it writes a one-page mini-spec first).
- Picks roles by size and risk; trivial work uses no sub-agents.
- Parallel tasks only when their files are disjoint; each parallel task gets its own git worktree.
- Progress in one machine-readable ledger; recoverable from the ledger plus `git log`.
- Commits on a feature branch; may open a PR (user-approved in the design discussion).
- `SKILL.md` under ~150 lines; role files ~30 lines each, loaded only when that role runs.

## Non-goals / anti-goals
- No standing "team" of agents. No role without its own output artifact.
- No dependency on product-intelligence, gstack or superpowers being installed (optional delegation with an inline fallback).
- No telemetry, update checks, learnings store or per-model overlays.
- Claude Code only for now (no Codex adapter yet).
- Never claims "tests pass" without a recorded command, exit code and output.

## Engineering principles (user-set, apply to every tier)
1. **Acceptance-criteria driven.** Every task traces to Given/When/Then criteria from the spec (or mini-spec). No criterion, no task. Work is done when its criteria pass, not when code exists.
2. **TDD by default.** Red (failing test for a criterion) -> green (minimal code) -> refactor. Skipped only when the user says so in that run; the skip is logged in `log.md`. For config/docs/pure-wiring tasks with nothing testable, the task records "no test: reason" instead of a token test.
3. **Test quality over quantity.** One test per acceptance criterion plus targeted edge/failure cases that guard real risk. Each test must name the criterion it protects. Prefer behaviour-level tests over mocks of internals; no tests that only restate the implementation, assert constants, or duplicate another test.
4. **Prune.** QA and reviewer delete tests that add no value (duplicates, tautologies, over-mocked, implementation-coupled) and report the deletions. Final gate: every test maps to a criterion or a named risk; unmapped tests are removed or justified.
5. **Test budget in the ledger.** Each task lists its criteria and the tests that cover them (`criteria -> tests`); the reviewer checks that mapping, not a coverage number.

## Flow
```
input: spec | raw idea -> mini-spec (goal, acceptance criteria, non-goals) -> user approves
TRIAGE (lead alone)  size x risk -> tier -> roles
  T0 tiny    lead inline, verify
  T1 small   engineer -> verify
  T2 normal  [architect if design open] -> engineer(s) -> QA -> reviewer      (plan sign-off)
  T3 risky   architect -> engineer(s) -> QA -> security lens -> reviewer      (plan sign-off)
PLAN    tasks.json DAG: id, deps, owned files, acceptance, verify cmd, status, passes
RUN     waves of tasks with no deps and disjoint files; one worktree each; lead integrates
TEST    per task, TDD: failing test per criterion first (red), then minimal code (green), refactor
VERIFY  QA runs real commands; only QA flips `passes`; tests/acceptance not editable by engineers; QA prunes low-value tests
REVIEW  fresh-context reviewer reads diff + spec only (read-only tools); Critical/High block
CLOSE   branch + commits (+ PR if asked); summary: changes, evidence, rulings, open decisions
```

## Roles (core/roles, same schema as product-intelligence: roles.json + one short md each)
- architect (reasoning tier): only when design is open; scope challenge (reuse existing code, minimum change set, stop if >8 files or >2 new services), then architecture/tests/performance risks, max 8 issues. Output: short design note + task DAG.
- software-engineer (standard): implements one task within its owned files via TDD (red test per criterion, then minimal code); no TODOs left, no scope creep.
- qa (standard): owns test quality. Reviews the engineer's red tests against the criteria, adds only missing risk cases, runs the verification command (records command, exit code, output), removes low-value tests, one regression test per bug fix in the project's own style.
- reviewer (reasoning): independent, severity-rated findings with location and required fix; fix-first for mechanical items; scope-drift check against the spec.
- optional lenses, called only by tier: security, database.

## Tracking and control
- `.implementation/<name>/tasks.json` (ledger) and `log.md` (rulings). Add `.implementation/` to the user's choice of ignore or commit.
- Decisions are classed mechanical / taste / user-challenge. Mechanical and taste are logged as `Ruling: what, why, cost if wrong`; taste goes to the single plan sign-off; user-challenge is never auto-decided.
- Hard stops: destructive operations, security-sensitive actions, shared side effects (push, deploy), unresolvable spec conflict.
- Safety: stay inside each task's owned files (freeze-style scope per worktree); stop a task after 3 failed fixes; stop the run if reverts and out-of-scope edits pile up (WTF score, from gstack QA loop).
- Completion status per task and for the run: DONE, DONE_WITH_CONCERNS, BLOCKED.
- Model tiers via config, never hardcoded; pass the model explicitly on every delegation.

## Borrowed (ideas, rewritten compactly; nothing copied wholesale)
| From | Idea |
|---|---|
| superpowers subagent-driven-development | ledger + git-log recovery, explicit model tiers, fresh implementer per task, capped fix loop |
| superpowers verification-before-completion | 5-line evidence gate |
| pr-review-orchestrator | risk tier picks specialists; one agent per dimension |
| autonomous | question-resolution order: project docs, code, ecosystem norm, conservative default (logged) |
| gstack plan-eng-review / autoplan | scope challenge; mechanical/taste/user-challenge decision classes; one sign-off gate |
| gstack qa / investigate / freeze | per-fix commit and regression test, root cause first, scope lock, WTF stop rule |
| Anthropic harness post | JSON ledger with `passes`, only verifier flips it; end-to-end check, not only unit tests |
| product-intelligence | role schema, install-agents generator, spec contract |

Optional delegation when present: gstack `/review`, `/ship`; always with an inline fallback.

## Approaches considered
1. Single big skill that does everything inline: simplest, but no independence in review and no parallelism. Rejected for T2+.
2. Fixed standing team of 4 agents per task: matches the mental model, but multiplies tokens (~15x) and blocks on trivial work. Rejected.
3. Tier-triaged lead + on-demand role agents + ledger (chosen): one agent by default, roles and parallelism only when justified.

## Left to the builder
Exact ledger schema fields, role prompt wording, the tier decision thresholds beyond the table, the install script for native Claude Code agents, tests for the ledger helper (small zero-dependency Node script like `pi.mjs`: `init`, `next`, `mark`, `status`), and docs kept to one README plus the skill.

## Open points (my calls, change if wrong)
- Ledger helper is a small Node script so state edits are deterministic, not hand-edited JSON.
- Mini-spec for raw ideas lives in `.implementation/<name>/spec.md`; for product-intelligence input the existing `FEATURE-NNN.md` is the spec and is not copied.
- The PR is opened only when the user says so in that run; pushing always needs the user's word.
