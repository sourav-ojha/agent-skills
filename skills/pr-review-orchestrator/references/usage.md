# Usage

## Invoke

```
/deep-pr-review 123
/deep-pr-review https://github.com/owner/repo/pull/123
/deep-pr-review --repo owner/name 123
/deep-pr-review                      # the PR for the current branch
```

Natural language works too: *"deeply review PR #123"*, *"orchestrate a review of this branch"*, *"is this PR ready to merge?"*.

**Which skill do I get?**

`pr-review-orchestrator` (this one) is the **default** for any PR review request. It self-limits on trivial diffs — a docs-only PR dispatches zero agents — so it is safe for small PRs too.

`pr-review` is the lighter single-pass alternative, and now triggers only when you explicitly ask for a *quick*, *light*, *shallow*, or *fast* review, or invoke `/pr-review`.

To force either one, name it: *"use pr-review-orchestrator"* / *"use the pr-review skill"*.

## Inputs

| Input | Behaviour |
|---|---|
| PR number / `#N` / URL | Reviews that PR |
| `--repo owner/name N` | Reviews a PR in another repo |
| nothing | The PR for the current branch |
| branch with no PR | Reviews the branch diff against its base, and says so |

## Execution flow

```
Resolve target, anchor to the PR's head revision
    ↓
Assess risk → pick tier (T0–T4)          ← the cost lever; T0 dispatches nobody
    ↓
Acquire context, scaled to tier: project rules, PR evidence, sibling files,
                                 repo-specific reviewers
    ↓
Build INTENT MODEL                        ← shared context for everything downstream
    ↓
┌── dispatched in parallel, read-only ───────────────────┐
│  correctness · architecture · security                 │
│  data/compat · perf/operability · tests · error paths  │   ← only the ones the diff justifies
└────────────────────────────────────────────────────────┘
    ↓  (project build / typecheck / lint / tests run concurrently, or CI results reused)
Verify each candidate → deduplicate by root cause → confidence threshold
    ↓
PR Gist + findings table + verification table + verdict + depth note
```

Sequential by necessity: context → intent → specialists, and specialists → verification → verdict. Everything inside the fan-out is concurrent.

## Severity

`BLOCKER` (do not merge) · `MAJOR` (fix before merge) · `MINOR` (real cost, safe to merge) · `QUESTION` (clarification needed to judge the change). Full definitions live in SKILL.md §7.

There is no `NIT` tier. Style is the linter's job.

## Output

Fixed structure, deliberately compact:

1. **PR Gist** — 2–5 bullets, purely functional. No judgement, no verdict hints. If you can guess the verdict from the Gist, the Gist is wrong.
2. **Findings** — one table, sorted BLOCKER → MAJOR → MINOR → QUESTION. Every row: where, what, why it matters, what to change. `No actionable findings.` is a valid and common result.
3. **Verification** — build / typecheck / lint / relevant tests / full suite, with `Not Run` and a reason where applicable.
4. **Test quality** — one line.
5. **Verdict** — `APPROVE` · `APPROVE WITH MINOR COMMENTS` · `REQUEST CHANGES` · `BLOCK`, plus 1–2 sentences.

## How repository rules and skills are consumed

Nothing project-specific is hardcoded. Each run, the workflow:

- reads `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `CONTRIBUTING.md` in the root **and in changed directories**;
- follows references from those into ADRs and architecture docs, but only for the **changed paths**;
- reads linter, formatter, `tsconfig`, and CI config to learn which rules are already enforced — those stop being review findings;
- discovers `.claude/skills/`, `.claude/agents/`, and repo-scoped skills, and **prefers a project-specific reviewer over the generic one** for any dimension it covers;
- extracts domain facts from a domain-knowledge skill into the intent model, rather than running it as a review pass;
- reads sibling files to learn the actual local pattern.

**Documentation is evidence, not truth.** Where a rule document and the code disagree, the code wins and the discrepancy is noted.

## Customize

| Want | Do |
|---|---|
| Force depth | *"review PR 123 at full depth"* / *"keep it light"* — overrides tier selection |
| One dimension only | *"just the security review of PR 123"* |
| Project-specific rules | Put them in the repo's `CLAUDE.md` / `AGENTS.md` — they are picked up automatically and outrank generic heuristics |
| A project-specific reviewer | Add a `.claude/skills/<name>/SKILL.md` with a description naming its dimension; routing prefers it |
| Change severity policy | Say so in the repo's `CLAUDE.md` (e.g. "missing tests on API routes are BLOCKER here") |
| Post to GitHub | Ask explicitly. Default is chat-only, every time — one approval does not carry to the next review |

## Safety

Read-only toward source. It reads files, inspects git, reads PR metadata, and runs build/typecheck/lint/test. It does **not** edit, write, stage, commit, push, merge, or post — and it never modifies the working tree to make a check pass, never stashes, and never creates a worktree.

This is **capability-enforced, not just requested**: all seven specialist agents (`pr-correctness-tracer`, `pr-architecture-reviewer`, `pr-security-reviewer`, `pr-data-compat-reviewer`, `pr-ops-perf-reviewer`, `pr-test-quality-reviewer`, `pr-error-path-reviewer`) declare `tools: Read, Grep, Glob, Bash` and hold no Edit or Write tool at all.

One exception, stated plainly: `pr-review-toolkit:type-design-analyzer` is composed from an installed plugin and **runs with unrestricted tools**, so its read-only behaviour rests on its prompt rather than on a capability limit. It is dispatched only for new-type analysis. The toolkit's other agents — `code-simplifier`, `code-reviewer`, `pr-test-analyzer`, `silent-failure-hunter` — are never dispatched, because they either modify code by design or hold write access without an analytical advantage over the read-only replacements.

Fixing is a separate workflow. Ask for it explicitly and separately.
