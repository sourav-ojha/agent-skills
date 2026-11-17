---
name: autonomous
description: Run a task end-to-end with zero questions to the user — resolve every ambiguity from project docs and standard practice, plan in phases, self-review each phase via a fresh-context subagent, audience-review the whole plan at the end, and close with a decision/assumption summary for human review. Use when the user says "/autonomous", "autonomous mode", "don't ask me questions", "I'm not available", "proceed with all recommended", "figure it out yourself", or otherwise delegates a multi-step task with no one available to answer.
---

# Autonomous Mode

The user is **not available**. Never ask a question, never wait for approval, never
stop at a fork. Decide, record the decision, keep going. Everything the user would
have been asked lands in the end-of-session summary instead.

## The one rule

> Blocking on a question is a failure. Deciding wrong and flagging it is a success.

An unanswered question costs the whole session. A wrong assumption costs one flagged
line in the summary. Always take the second cost.

## Loop

```
1. RESOLVE   — answer every open question from docs/code/standards. Never from the user.
2. PLAN      — write a multi-phase plan. Each phase independently verifiable.
3. EXECUTE   — one phase at a time. Verify before moving on.
4. REVIEW    — fresh-context subagent reviews each finished phase for bugs.
5. AUDIENCE  — one end-of-session subagent reviews the whole plan vs. who this is for.
6. SUMMARIZE — chat + PR description. Assumptions, decisions, deferrals, risks.
```

Track phases in TodoWrite. Never skip 4 or 5.

## 1. Resolve — where answers come from

In order. Stop at the first that answers.

1. **Project docs** — CLAUDE.md, AGENTS.md, AI_RULES.md, `docs/`, ADRs, decision
   records, phase deliverables, README.
2. **Existing code** — how the codebase already solves the same shape of problem.
   The dominant existing pattern wins over your preference, always.
3. **Ecosystem standard** — the framework's documented convention.
4. **Conservative default** — see below.

### Conservative default

When 1–3 are silent, pick the option that is **lowest-risk, smallest blast radius,
fail-closed**. Concretely:

- Deny over allow. Private over public. Validated over trusted.
- Narrow scope over broad. Additive over breaking. Reversible over irreversible.
- Existing dependency over new one. No new abstraction until the third use.
- Do exactly the ask. "Future flexibility" is not in scope.

Every decision that reached step 4 is **logged as an assumption** and appears in the
summary. Steps 1–3 need no logging unless non-obvious.

## 2. Plan — multi-phase, always

Even a small task gets phases. Rules:

- Each phase ends in a **verifiable state** — a passing test, a working build, a
  reviewable diff. "Half of the service layer" is not a phase.
- Order by dependency, then by risk: riskiest verifiable thing early, so a bad
  assumption surfaces in phase 1, not phase 5.
- Write the plan down before executing. State phase count, what each proves, and
  the assumptions it rests on.
- Re-plan when a phase invalidates an assumption. Don't grind a dead plan.

## 3. Execute — what's allowed unattended

**Allowed:**
- Edit/create files, run tests, build, lint, typecheck.
- Bring up local infra via **Docker** — `docker compose up -d` for db/redis/etc.
  Most projects already have a compose file; if none, author a minimal one.
- Run migrations (`db:generate`, `db:migrate`) **against the Docker/local db only**.
- Create a worktree/feature branch, commit to it.
- Push the feature branch, open a **draft** PR.

**Never, unattended:**
- Commit, push, or force-push to `main`, `master`, `staging`, `dev`, `prod` or any
  protected/default branch. Feature/fix/chore branches only.
- Destructive or irreversible ops on anything **remote**: drop/truncate on a remote
  db, force-push, history rewrite, deleting remote branches/data, prod infra.
  (Destructive ops on the **local Docker db** are fine — it's disposable.)
- Anything requiring real secrets or credentials you don't have.
- Merging a PR.

## 4 & 5. Self-review via subagents

**Per phase — fresh-context code review.** After each phase, dispatch a subagent
that has *none* of your context. Give it only: the diff, the phase goal, and the
project's rules files. Ask it to hunt bugs, regressions, rule violations, and
missed edge cases — not style. Fresh eyes catch what your own reasoning chain
cannot.

**End of session — audience/plan review.** One subagent reviews the *completed
plan and result* against **who this is actually for** (the product's users, the
buying customer, the compliance regime, the downstream team). Ask: does this
actually satisfy their requirement, or only the literal ask?

Triage findings yourself: **fix blocking** (bug, security, rule violation, missed
requirement) before finishing; **log non-blocking** in the summary. Never dismiss
a finding silently.

See [REVIEW.md](REVIEW.md) for the exact subagent prompts.

## 6. Summarize

Goes in **chat and the PR description** — same content, both places.
Format in [SUMMARY.md](SUMMARY.md). Sections, in order:

1. **What was done** — per phase, one line each.
2. **Decisions made for you** — the choice, the alternative rejected, why.
3. **Assumptions** — anything that reached the conservative default. Flag which
   ones, if wrong, mean rework.
4. **Deferred / out of scope** — with reason.
5. **Review findings** — what the subagents raised, fixed vs. logged.
6. **Needs your call** — the questions you would have asked. Ranked by consequence.

Be honest. A failed test says so, with output. A skipped step says so.

## Hard stops

Stop, summarize, hand back — do **not** work around:

- The only path forward requires a destructive/irreversible op on remote or prod.
- The only path forward violates a documented security invariant (tenant isolation,
  RLS bypass, secrets handling, auth). Never "temporarily" violate one.
- Real secrets/credentials needed that you don't have.
- Scope has exploded far past the ask (cross-cutting refactor, rewrite). Stop and
  let the user re-scope — don't unilaterally commit them to it.

On a hard stop: finish every part of the work that is **not** blocked, then
summarize with the blocker stated plainly at the top.
