---
name: pr-review
description: "Quick single-pass pull request review against the target project's own conventions, done inline without sub-agents. Fetches the PR with gh CLI (or a GitHub MCP), infers project rules from CLAUDE.md/AGENTS.md/lint config/neighbouring code, then reports correctness, security, convention, over-engineering, and test-quality findings as bullet points with a summary and an explicit verdict. Use only when the user explicitly asks for a quick, light, shallow, or fast review, or invokes /pr-review. For any other PR review request — \"review PR #N\", a pasted PR URL, \"is this ready to merge\" — use the `pr-review-orchestrator` skill instead, which establishes PR intent and verifies its findings."
user-invocable: true
---

# PR Review

Review a pull request the way a strong senior engineer on *that* project would: judged against the project's own conventions, not generic taste.

## Quick start

```bash
gh pr view 194 --json number,title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,url
gh pr diff 194
```

Then work through the workflow below and emit the [output format](#output-format).

## Inputs

Accept any of: `#194`, `194`, a PR URL, `--repo owner/name 194`, or nothing (then use the PR for the current branch: `gh pr view --json number`). If no PR exists for the branch, review the diff against the base branch instead (`git diff $(git merge-base HEAD origin/<default>)...HEAD`) and say so in the summary.

## Workflow

Run phases in order. Do not skip Phase 1 — a review that doesn't know the project's rules is worthless.

### Phase 1 — Establish project ground truth

Before reading the diff, learn what "correct" means here:

1. Read `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `CONTRIBUTING.md` at repo root and in the changed dirs. Project rules **outrank** every generic heuristic in this skill.
2. Read any referenced rule docs (e.g. `AI_RULES.md`, `docs/architecture/*.md`, ADRs) that are relevant to the changed paths.
3. Check tooling config for the *enforced* rules — `eslint`/`biome`/`ruff`/`.editorconfig`, `tsconfig` strictness, commitlint, CI workflow. Anything the linter already catches is a **nit at most**; don't spend review budget on it.
4. If `graphify-out/graph.json` exists, use `graphify query "<area>"` to orient before reading source.
5. Read 1–2 sibling files of each changed file to learn the *actual* local pattern (layering, naming, error handling, test style). Convention is what the neighbours do, not what you'd prefer.

### Phase 2 — Understand the change

```bash
gh pr view <N> --json title,body,author,labels,url,additions,deletions,changedFiles
gh pr diff <N>
gh pr view <N> --json commits --jq '.commits[].messageHeadline'
gh pr checks <N>
gh pr view <N> --json reviews,comments   # don't repeat existing feedback
```

Read the **full current file** for any non-trivial hunk — diff context hides the bug more often than it reveals it. State the PR's intent in your own words before judging it. If the intent is unclear from title/body/commits, that is itself a finding.

### Phase 3 — Review passes

Make each pass explicitly. See [CHECKLIST.md](CHECKLIST.md) for the full per-pass item list.

| Pass | Looking for |
|---|---|
| Correctness | Logic errors, off-by-one, null/undefined, async races, unhandled rejections, wrong error path, state-machine holes |
| Security | Authz/tenant-scope gaps, injection, secrets, unsafe deserialization, SSRF, missing input validation, unsafe file handling |
| Conventions | Deviations from Phase 1 ground truth: layering, naming, file placement, error style, API-schema patterns |
| Over-engineering | Abstractions with one caller, config flags nobody asked for, premature generics, speculative extension points, defensive code for impossible states, backwards-compat shims in a codebase that doesn't need them |
| Test quality | See below — this is a required pass, not optional |
| Data & migrations | Destructive/blocking DDL, missing index, missing rollback, nullable-vs-default, backfill on large tables |
| Performance | N+1 queries, unbounded fetch, sync work in a request path, missing pagination |
| API/contract | Breaking response shape, missing validation, undocumented status codes, client/server type drift |
| Observability & docs | Swallowed errors, missing logs on failure paths, stale docs/comments the change invalidates |

**Test-quality pass (mandatory).** For every behaviour change, ask:
- Are there tests at all? If none and the code is non-trivial, that's a **Blocking** or **Major** finding depending on project norms.
- Do tests assert *behaviour* or just that the code ran? Flag: asserting on mocks you wrote, `expect(x).toBeDefined()`, snapshot-only coverage of logic, no assertion at all, tests that pass if the implementation is deleted.
- Are error paths and edge cases covered, or only the happy path?
- Are they deterministic? Flag shared mutable state, real clock/network/DB dependence, order-dependence, hardcoded IDs against a shared dev DB.
- Is coverage theatre happening — many tests, no meaningful assertions? Say so plainly.

### Phase 4 — Verify before claiming

Never report a finding you haven't checked. For each candidate:
- Re-read the actual file at the actual line.
- Confirm the failure is reachable — write the concrete input → wrong output in one line. If you can't, downgrade or drop it.
- Confirm it isn't already handled elsewhere (caller, middleware, DB constraint, type system).
- Confirm it's caused by *this* PR, not pre-existing. Pre-existing issues go in a separate "Out of scope / pre-existing" bullet, never as blockers.

Drop anything that survives as speculation. A short verified list beats a long plausible one.

### Phase 5 — Report

Emit the output format below. Default is a **written report in chat only**. Only run `gh pr review` / `gh pr comment` if the user explicitly asks you to post it — posting to GitHub is outward-facing and needs their go-ahead.

## Severity

| Severity | Meaning |
|---|---|
| **Blocking** | Correctness, security, or data-loss defect. Must fix before merge. |
| **Major** | Real problem — wrong abstraction, missing tests on risky logic, convention break that will spread. Fix before merge or file a follow-up. |
| **Minor** | Worth fixing, safe to merge without. |
| **Nit** | Style/preference. Mark clearly as non-blocking. Keep these few. |
| **Question** | Genuinely unsure of intent. Ask, don't assert. |

## Output format

```markdown
## PR #<N> — <title>
<repo> · <author> · <head> → <base> · +<add>/−<del> across <n> files · CI: <status>

### What this PR does
2–4 sentences in your own words: the problem, the approach, the user-visible effect.

### Findings

**Blocking**
- `path/to/file.ts:42` — <defect>. <Concrete failure: input → wrong result.> Fix: <what to do>.

**Major**
- `path/to/file.ts:88` — ...

**Minor**
- ...

**Nits** (non-blocking)
- ...

**Questions**
- ...

### Test quality
- Coverage of the change: <what is / isn't tested>
- Assertion quality: <meaningful vs. theatre, with examples>
- Gaps: <specific untested branches>

### Over-engineering check
- <Anything doing more than the ticket needs, or "None — scope is tight.">

### Out of scope / pre-existing
- <Issues noticed but not introduced by this PR.>

### Verdict
**<Approve | Approve with nits | Request changes | Needs discussion>** — one-sentence justification.
```

Every finding bullet: file:line, what's wrong, why it matters concretely, what to do. No bullet without all four.

## Rules

- **Project conventions win.** If this skill and the repo's CLAUDE.md disagree, the repo wins. Say which rule you're applying.
- **Review the diff, not the codebase.** Don't propose rewrites of untouched code.
- **Don't reward volume.** "No blocking issues" is a perfectly good review. Padding a report with nits is a failure mode.
- **Cut over-engineering both ways** — flag it in the PR, and don't commit it in your own suggestions.
- **Be specific and neutral.** Critique the code, never the author. No "you forgot"; use "this path misses".
- **Don't repeat** what CI, the linter, or an existing review comment already flagged — reference it in one line instead.
- **Never push, merge, or post** without an explicit request.

## Reference

- [CHECKLIST.md](CHECKLIST.md) — full per-pass checklist and language-specific items
- [GH_COMMANDS.md](GH_COMMANDS.md) — gh CLI / MCP recipes, inline comments, multi-comment reviews
