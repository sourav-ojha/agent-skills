# Implementer Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `skills/implementer`: a lean, tier-triaged multi-role implementation skill for Claude Code with a deterministic task-ledger helper.

**Architecture:** `SKILL.md` (lead procedure, under 150 lines) plus on-demand role files and two short references. State lives in `.implementation/<name>/tasks.json` (a DAG ledger) edited only through a zero-dependency Node helper `impl.mjs`, whose pure logic sits in `lib/ledger.mjs`. Native Claude Code agents are generated from `roles.json` by a small `install-agents.mjs`.

**Tech Stack:** Node >=22 ESM, zero dependencies, `node:test`. Same repo conventions as `skills/product-intelligence`.

**Spec:** `docs/superpowers/specs/2026-11-17-implementer-design.md`

## Global Constraints
- `SKILL.md` <= 150 lines; each role file <= 40 lines; helper has zero dependencies.
- Claude Code only. Models are tier aliases from `core/config.default.json` (`reasoning: opus`, `standard: sonnet`, `fast: haiku`), never hardcoded in prompts.
- TDD and acceptance-criteria driven: every task and test traces to a criterion; tests kept few and valuable (spec principles 1-5).
- Skill never pushes; commits on a feature branch; PR only when the user says so in that run.
- Must pass `npm run check` (repo validator + tests) and not require product-intelligence.

## Review Focus
- `--name` containing `../` or a path separator: must be rejected (no writes outside `.implementation/`).
- Ledger file missing or invalid JSON: clear error, never a silent re-init.
- File ownership overlap by directory prefix (`src/` vs `src/a.js`): counts as a conflict.
- Re-running `plan` over a ledger with started tasks: refused (would erase progress).
- Interrupted write: ledger saved atomically (temp file + rename).

## Acceptance criteria (the whole build is done when these hold)
- AC1 A plan with a cycle, unknown dependency, or a task lacking criteria is rejected.
- AC2 `nextBatch` returns only ready tasks (deps passed), with disjoint file ownership (prefix-aware), capped, excluding files held by in-progress tasks.
- AC3 `start` refuses unmet deps or file conflicts; `finish` never sets `passes`.
- AC4 `pass` requires evidence (`cmd`, `exit 0`) and every criterion mapped to tests or an explicit `noTest` reason.
- AC5 The CLI runs init, plan, start, finish, pass, status end to end, persists, and appends rulings to `log.md`.
- AC6 `install-agents.mjs` writes one agent file per role (tools from capabilities, model from tier) and rejects an unsafe model name.
- AC7 Skill size caps hold and `npm run validate` passes for `implementer`.

---

### Task 1: Ledger library and CLI (AC1-AC5)

**Files:**
- Create: `skills/implementer/core/scripts/lib/ledger.mjs`, `skills/implementer/core/scripts/impl.mjs`
- Test: `tests/validation/implementer-ledger.test.mjs`

**Interfaces:**
- Produces (`ledger.mjs`): `validatePlan(plan): string[]`; `nextBatch(plan, max = 4): string[]`; `startTask(plan, id): void`, `finishTask(plan, id): void`, `blockTask(plan, id, reason): void`, `passTask(plan, id, { cmd: string, exit: number, at?: string }): void` (mutators throw `Error` with a clear message); `ownsOverlap(a: string[], b: string[]): boolean`; `safeName(name): string` (throws on separators/`..`).
- Plan shape: `{ name, tier: 'T0'|'T1'|'T2'|'T3', spec?, tasks: [{ id, title, deps: string[], files: string[], criteria: [{ id, text, tests: string[], noTest?: string }], verify: string, status: 'pending'|'in_progress'|'done'|'blocked', passes: boolean, evidence: {cmd, exit, at}|null, note?: string }] }`
- CLI: `node impl.mjs <init|plan|batch|start|finish|pass|block|ruling|status> --name N [--dir D] ...`. `plan --file plan.json` loads and validates tasks (refuses if any existing task is past `pending`). `pass <id> --cmd C --exit 0`. `ruling --what W --why Y --cost C`. Ledger at `<dir>/.implementation/<name>/tasks.json`, log at `log.md` beside it. Writes are atomic.

- [ ] **Step 1: Write failing tests** (`node:test`, each tagged with its AC): `AC1 rejects cycle, unknown dep, task without criteria` (one table-driven test, three plans); `AC2 nextBatch: deps, disjoint files incl. prefix overlap, cap, in-progress files excluded`; `AC3 start refuses unmet deps and file conflicts; finish leaves passes false`; `AC4 pass needs exit 0 evidence and criteria mapped to tests or noTest`; `AC5 CLI end to end in a temp dir: init, plan, start, finish, pass, status shows 1/1 passed, ruling lands in log.md, plan refused after start, bad JSON ledger errors, --name ../x rejected`.
- [ ] **Step 2: Run** `node --test tests/validation/implementer-ledger.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `ledger.mjs`** (pure functions above; cycle check by DFS; prefix-aware overlap treats `src/` and `src/a.js` as conflicting).
- [ ] **Step 4: Implement `impl.mjs`** (argument parsing like `pi.mjs`; atomic write via temp file + `rename`; `status` prints counts, per-task state, and the suggested next batch).
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit** `feat(implementer): task ledger helper` (branch `feat/implementer-skill`).

### Task 2: Roles and Claude Code agent generator (AC6)

**Files:**
- Create: `skills/implementer/core/roles/{roles.json,architect.md,software-engineer.md,qa.md,reviewer.md}`, `skills/implementer/core/config.default.json`, `skills/implementer/core/scripts/install-agents.mjs`
- Test: `tests/validation/implementer-agents.test.mjs`

**Interfaces:**
- Produces: `roles.json` `{ roles: [{ name, description, tier, capabilities }] }` for `architect`(reasoning), `software-engineer`(standard, adds `edit`,`shell`), `qa`(standard, `edit`,`shell`), `reviewer`(reasoning, read-only). Optional lenses `security`, `database` (reasoning, read-only).
- `install-agents.mjs`: exports `renderClaude(role, config): string` and `MODEL_RE`; CLI `--scope user|project [--project-dir D] [--dry-run] [--remove]` writes `impl-<role>.md` into `~/.claude/agents` or `<project>/.claude/agents`.
- Role files follow product-intelligence shape (untrusted-data rule, Input, Procedure, Output, Rules) and carry the spec's role content: architect scope challenge (>8 files or >2 new services = stop and ask); engineer TDD red/green with owned-files only; qa test-quality and pruning; reviewer fresh-context, severity-rated, criteria-to-tests mapping check.

- [ ] **Step 1: Write failing tests:** `AC6 renderClaude: tools from capabilities, model alias from tier, one file per role` and `AC6 rejects model name with newline or extra key`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Write `roles.json`, `config.default.json`, the four role files** (<= 40 lines each) and **implement `install-agents.mjs`** (model aliases validated by `MODEL_RE`; agent body tells the agent to read its role file first, path supplied by the delegation).
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(implementer): roles and agent generator`.

### Task 3: SKILL.md, references, templates, adapter (AC7)

**Files:**
- Create: `skills/implementer/SKILL.md`, `references/triage.md` (tier table, role selection, cost rules), `references/tdd-and-acceptance.md` (principles 1-5, test-pruning rules, evidence gate), `templates/mini-spec.md` (goal, Given/When/Then criteria, non-goals), `adapters/claude-code/README.md` (install, agent generation, optional gstack `/review`/`/ship` delegation with inline fallback)
- Test: `tests/validation/implementer-skill.test.mjs`

**Interfaces:** `SKILL.md` frontmatter `name: implementer`, a description that says when to use it (implement an approved spec or a raw idea with architect/engineer/QA/reviewer roles chosen by size and risk). Body: input modes, triage, plan sign-off for T2+, ledger commands, wave dispatch (disjoint files, worktree each), TDD loop, verification gate, review, close with commit/PR rules, hard stops, rulings.

- [ ] **Step 1: Write failing test:** `AC7 SKILL.md <= 150 lines, each role file <= 40 lines, every file linked from SKILL.md exists, frontmatter name matches directory`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Write the files above** (no restating of role content in SKILL.md; link instead).
- [ ] **Step 4: Run** the test file, then `npm run validate`. Expected: PASS, validator reports no errors for `implementer`.
- [ ] **Step 5: Commit** `feat(implementer): skill, references, adapter`.

### Task 4: Repo wiring and full check (AC7)

**Files:**
- Modify: `package.json` (script `package:implementer`), `README.md` (list the second skill), `CHANGELOG.md` (Unreleased entry), `scripts/validate-skills.mjs` (required-file list for `implementer`, as done for product-intelligence)
- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `npm run check`. Expected: validator clean, all tests (existing plus new) pass.
- [ ] **Step 3: Whole-branch fresh review** (independent reviewer on the diff vs `main`, criteria-to-tests mapping, prune any test without value). Fix Critical/High.
- [ ] **Step 4: Commit** `chore(implementer): wire into repo`. Do not push or open a PR without the user's word.
