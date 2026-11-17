# Capability Routing — Use What The Repo Already Has

This skill is globally reusable, so it hardcodes **no** project rules. It discovers them per repository, every run.

## Discover

Once, in §3a, cheaply:

```bash
ls .claude/skills/ .claude/agents/ .claude/commands/ .claude/rules/ 2>/dev/null
ls .agents/ 2>/dev/null
ls -d docs/architecture docs/adr docs/decisions 2>/dev/null
```

Also scan the session's available-skills list for repository-scoped skills (they appear with a directory prefix, e.g. `apps/web:deploy`).

For each candidate, read **only its frontmatter `description`** — not its body. The description says what it covers and when to use it. Reading bodies of ten skills to route two is exactly the waste this file exists to prevent.

## Precedence, per dimension

For each dimension you decided to review in §2, pick **one** reviewer:

1. **Repository-specific skill or agent covering that dimension** — it knows invariants a generic agent cannot infer (a tenant-isolation rule, a migration journal requirement, a domain state machine). Strongest signal.
2. **The generic specialist** from this skill (`pr-*-reviewer` / `pr-correctness-tracer`).
3. **`pr-review-toolkit:type-design-analyzer`**, for new-type analysis only — the sole toolkit agent this workflow dispatches. Every other toolkit reviewer holds Edit/Write and is superseded by a read-only in-house agent; see SKILL.md §4b.

Never run two reviewers for the same dimension. The second one produces duplicates you pay for twice — once to generate, once to deduplicate.

## Typical mappings

| Dimension | Prefer a repo capability whose description mentions… |
|---|---|
| Security | security review, threat model, auth, encryption, vulnerability |
| Compliance | SOC 2, HIPAA, PCI, audit controls, retention |
| Data / migrations | migration review, schema safety, RLS, tenant isolation |
| Architecture / conventions | pattern enforcement, layering, module boundaries, coding standards |
| API contracts | contract checking, schema drift, client/server type parity |
| Frontend | the repo's frontend engineering standards skill |
| Domain reasoning | a domain-knowledge skill (pentest, edtech, fintech, infra) — feed it as **context** to the correctness tracer, do not run it as a reviewer |

## How to use a repository capability

Two shapes:

- **A skill** — invoke it with the `Skill` tool, in your own context, giving it the intent model and the changed files. Then treat its output as candidate findings like any specialist's.
- **An agent** (`.claude/agents/*.md`) — dispatch it with `Agent` using its name, with the same prompt contract as a generic specialist (intent model, files, scope, read-only).

Either way its output goes through §6 verification. **A project skill's finding is not automatically true** — it may encode a rule the codebase has since moved past. Verify it in the code like anything else.

## Domain skills are context, not reviewers

A domain-knowledge skill (how pentest delivery works, how a curriculum is structured, how a payment settles) improves **functional reasoning**. Extract 3–8 lines of relevant domain facts from it into the intent model's `business rules` and `failure scenarios`. Do not dispatch it as a review pass — it will produce product opinions, not merge-blocking findings.

## Rules from documents

Rule documents (`CLAUDE.md`, `AI_RULES.md`, ADRs, architecture docs) are inputs to specialist prompts — but pass only the **subset relevant to that specialist's dimension and the changed paths**. Pasting a 400-line rule file into five prompts is the single most common waste in this workflow.

And per the skill's core principle: **verify a rule against the code before enforcing it.** A stale rule generates a confident, wrong finding — the worst output this workflow can produce.
