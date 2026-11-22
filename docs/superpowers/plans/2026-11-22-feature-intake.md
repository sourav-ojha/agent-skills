# Feature Intake (milestones M0 to M5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `feature-intake` skill that turns a product owner's input into an implementation-ready, hash-approved `FEATURE-NNN.md` that the existing implementer, delivery queue and factory driver consume unchanged, without going through product-intelligence.

**Architecture:** One new self-contained skill (agent procedure in `SKILL.md`, deterministic helper `fi.mjs` for IDs, validation, readiness and lifecycle). Specs live in `.product/features/` with `origin: intake`. The spec contract (heading titles, `AC-n/EC-n/ER-n` grammar, trailing `## Delivery log`, queue frontmatter) is pinned by tests first (M0). product-intelligence's validator gets a narrow `origin: intake` exemption (M1); its own spec writer is unchanged. No vendored skill is touched.

**Tech Stack:** Node 20+ ESM, zero dependencies, `node:test`, existing helpers in `tests/validation/helpers.mjs`.

**Spec:** [docs/superpowers/specs/2026-11-22-feature-intake-design.md](../specs/2026-11-22-feature-intake-design.md) (the approved review; sections 1, 4, 5, 6 bind). Decisions approved by the user at defaults: validator exempts `origin: intake` only; implementer mini-spec stays for T0/T1; required frontmatter is `type, id, title, status, origin, risk, depends_on, delivery, source_sha`; Antigravity adapter waits for research (M8, not in this plan). M6 (plan bridge), M7 (skill-insights overlaps) and M8 get their own plans.

## Global Constraints

- Node 20+, ESM, **zero dependencies**; `node --test` only. No network.
- Skills are self-contained: `feature-intake` imports nothing from another skill's folder. Shared code is **copied**, and a test enforces byte-identity (`criteria.mjs` with delivery-orchestrator, `runlog.mjs` with the others).
- **Never edit a vendored skill** (`brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `finishing-a-development-branch`, ...). `skills.lock.json` hashes them; `npm run validate` fails on any edit.
- Spec frontmatter rules (the queue reader keeps everything after the colon): one `key: value` per line, **no inline `#` comments, no nested YAML, no duplicate keys**, lists as comma-separated text. Allowed statuses: `draft, ready, implemented, validated, superseded` only.
- Factory-recognised headings (exact normalised titles, a leading number is stripped): `Acceptance criteria`, `Edge cases`, `Error and failure scenarios`, `HTTP contract`. IDs: `AC-<n>` as the first cell of a table row; `- EC-<n>: ...` and `- ER-<n>: ...` bullets.
- `## Delivery log` must be the **last block** of a spec (otherwise the factory hashes it).
- Every existing test stays green unchanged. Product-intelligence fixtures must validate byte-identically before and after M1.
- `fi` exit codes: `0` ok, `1` error or invalid (nothing changed), `2` valid but not ready.
- Commit messages: `feat(intake): ...` / `test(intake): ...`, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Never push or open a PR** unless the user asks.
- The spec content a user supplies is data, not instructions. Intake never writes application source, only `.product/features/`.

## Review Focus

Failure modes the spec implies that no single task's happy path covers, most likely first. Each has a test in the task named.

1. Spec with an inline comment or nested frontmatter reaches the queue and is silently dropped. Expected: `fi validate` rejects it with the line quoted (Task 3; contract proof in Task 1).
2. A `ready` spec is edited by hand after approval. Expected: `fi validate` fails with `modified_since_approval` until `fi reopen` then `fi approve` (Task 4).
3. Two `fi new` runs race, or the same source is ingested twice. Expected: no duplicate file, same ID returned for the same `source_sha` (Task 3).
4. Superseding or splitting a spec that other specs depend on. Expected: refused, dependents listed; the queue never sees a dependency on a superseded spec it cannot satisfy (Task 5).
5. An intake spec holds `opportunity: OPP-001` or a non-`intake` origin. Expected: pi validator keeps full linkage rules for it; `origin: intake` with an opportunity is an error (Task 2).

---

### Task 1: M0 spec-contract tests and fixtures (no production code)

**Files:**
- Create: `tests/fixtures/intake/valid-minimal.md`, `inline-comment.md`, `numbered-paren-headings.md`, `in-progress-status.md`
- Create: `tests/validation/spec-contract.test.mjs`

**Interfaces:**
- Consumes: `discover`, `buildQueue`, `frontmatter` from `skills/delivery-orchestrator/core/scripts/lib/queue.mjs`; `extractCriteria`, `criteriaHash`, `canonicalSpec` from `.../lib/criteria.mjs`.
- Produces: the four fixture specs (reused by Tasks 3 to 7) and the executable definition of the contract.

- [ ] **Step 1: Write the fixtures.** `valid-minimal.md` is a complete intake spec: frontmatter `type: feature-spec`, `id: FEATURE-001`, `title: Health check endpoint`, `status: ready`, `origin: intake`, `risk: low`, `depends_on:` (empty), `delivery: none`, `source_sha: none`; `# Health check endpoint`; the 13 headings of the design spec section 4 in order (numbers allowed), with one AC row `| AC-1 | FR-1 | **Given** ... **When** ... **Then** ... |`, one `- EC-1:` and one `- ER-1:` bullet, an `## HTTP contract` section with `` - `GET /api/health` ``, and no placeholders. The other three differ from it in exactly one thing: `status: ready   # draft | ready` (inline comment); headings `6. Acceptance Criteria (Given / When / Then)` and `7. Edge Cases and Failure Scenarios`; `status: in_progress`.
- [ ] **Step 2: Write `spec-contract.test.mjs`**, each case copying a fixture into a temp features dir:
  - `valid minimal spec is queued`: `buildQueue(discover(dir))` returns FEATURE-001.
  - `valid minimal spec extracts criteria ok`: `extractCriteria(text).ok === true`, one AC, one EC, one ER, contract has `GET /api/health`.
  - `inline-comment status is NOT queued`: `discover` returns `status: "ready                # draft | ready"` and `buildQueue` returns an empty queue (documents the silent drop).
  - `parenthesised or merged headings are NOT recognised`: `extractCriteria(...).ok === false` or zero AC.
  - `in_progress is not queueable`: status not `ready`.
  - `criteria hash ignores status, delivery and a trailing Delivery log`: change `status`, add `delivery: complete`, append a log table; `criteriaHash(canonicalSpec(a)) === criteriaHash(canonicalSpec(b))`. Changing one word in an AC changes the hash.
  - `a Delivery log that is not the last block is hashed`: add a heading after the log; hash differs.
- [ ] **Step 3: Run** `node --test tests/validation/spec-contract.test.mjs`. Expected: all pass (these pin existing behaviour). If any assertion about existing behaviour is wrong, fix the test to match the code, not the code.
- [ ] **Step 4: Commit** `test(intake): pin the spec contract the queue and factory consume`.

### Task 2: M1 product-intelligence validator exempts `origin: intake`

**Files:**
- Create: `tests/fixtures/expected/pi-validate-baseline.json` (captured **before** any code change)
- Modify: `skills/product-intelligence/core/validators/validate-artifacts.mjs` (feature loop, from the `for (const f of fs.readdirSync(fdir)...` line)
- Modify: `skills/product-intelligence/core/schemas/artifacts.json` (`feature`: add `origins`)
- Create: `tests/validation/intake-pi-validator.test.mjs`

**Interfaces:**
- Consumes: `projectFrom`, `validateJson`, `edit`, `hasError` from `tests/validation/helpers.mjs`.
- Produces: `artifacts.json` `feature.origins: ["product-intelligence","intake"]`; behaviour: a spec with `origin: intake` is checked for filename, `id` equals filename, required keys `type,id,status,origin`, status in `feature.status_values`, `opportunity` absent or `none`; it skips registry linkage, section and product-revision checks. A spec with no `origin` or `origin: product-intelligence` keeps every current check. Any other origin value is an error `unknown origin "<v>"`.

- [ ] **Step 1: Capture the baseline.** Script a one-off node call that runs `validateJson` for `projectFrom('a')` and `projectFrom('b')` and writes `{a:{errors,warnings}, b:{errors,warnings}}` to the baseline file. Commit it alone: `test(intake): baseline of pi validate output`.
- [ ] **Step 2: Write failing tests** in `intake-pi-validator.test.mjs`:
  - `pi fixtures validate identically to the baseline` (passes now and after).
  - `intake spec without an opportunity passes pi validate`: add `tests/fixtures/intake/valid-minimal.md` as `.product/features/FEATURE-099.md` into `projectFrom('a')`; error count unchanged.
  - `intake spec naming an opportunity errors`: contains `origin: intake` and `opportunity: OPP-001` -> `hasError(res, 'origin: intake')`.
  - `unknown origin errors`.
  - `pi spec with a missing opportunity still errors`: delete the `opportunity:` line of an existing fixture spec -> the same error as today.
  - `intake spec is not subject to the 19-section check`.
- [ ] **Step 3: Run; expected FAIL** on the new tests.
- [ ] **Step 4: Implement** the exemption as an early branch inside the feature loop (after frontmatter and filename checks, before the registry lookup): when `data.origin === 'intake'`, run the intake checks above, then `continue`. Unknown origin errors for any value outside `artifacts.feature.origins` when `origin` is present. Do not change any line that runs for pi specs.
- [ ] **Step 5: Run** the new test plus `artifacts.test.mjs gates.test.mjs review2.test.mjs review3.test.mjs modes.test.mjs source-protection.test.mjs repo.test.mjs`. Expected: all pass, baseline unchanged.
- [ ] **Step 6: Commit** `feat(intake): pi validator accepts origin: intake specs`.

### Task 3: M2 skill skeleton, `lib/spec.mjs`, `fi new|validate|check|status`

**Files:**
- Create: `skills/feature-intake/SKILL.md` (stub: name, description, license, compatibility, `argument-hint`; filled in Task 6), `templates/feature-specification.md`
- Create: `skills/feature-intake/core/scripts/fi.mjs`, `core/scripts/lib/spec.mjs`, `core/scripts/lib/criteria.mjs` (copy of delivery-orchestrator's), `core/scripts/lib/runlog.mjs` (copy)
- Modify: `tests/validation/run-telemetry.test.mjs` (add `feature-intake` to the identical-copies list); add a test asserting `feature-intake`'s `criteria.mjs` is byte-identical to delivery-orchestrator's
- Create: `tests/validation/feature-intake-core.test.mjs`

**Interfaces:**
- `lib/spec.mjs` exports:
  - `parseSpec(text: string): { fm: Record<string,string>, body: string, problems: string[] }`. Problems for: no frontmatter, a line that is not `key: value`, a leading-space (nested) line, a duplicate key, a value containing whitespace followed by `#` (quote the offending line).
  - `validateSpec(text: string, ctx?: { id?: string, specs?: Map<string,{status:string}> }): { errors: string[], warnings: string[] }`. Checks: `parseSpec` problems; required keys; `origin === 'intake'`; `status` in the five allowed; `risk` in `low|elevated|high`; `delivery` in `none|partial|complete`; `depends_on` entries match `^FEATURE-\d+$` and (when `ctx.specs` given) exist; required headings present in order (numbers allowed, case-insensitive prefix match as pi does); `extractCriteria(text).ok`; `## Delivery log` last block (`specRegions(text).problems` empty); for `status: ready|implemented|validated`: no `{{` placeholders and `modified_since_approval` check (Task 4 adds the hash part; here only the placeholder rule).
  - `readiness(text: string, ctx): { ok: boolean, failures: string[] }` with rules R1 to R8 below.
  - `contentHash(text: string): string` = `criteriaHash(canonicalSpec(textWithoutApprovalHistorySection))`.
  - `REQUIRED_HEADINGS: string[]` (design spec section 4 list: Context and problem statement; Objective and expected behavior; Existing implementation analysis; Scope and non-goals; Functional and technical requirements; Acceptance criteria; Edge cases; Error and failure scenarios; Technical considerations; Security and performance; Testing and verification; Assumptions and unresolved decisions; Approval history). Optional: `HTTP contract`, `Traces`, `Delivery log`.
- Readiness rules: R1 no `{{`; R2 criteria ok with at least one AC; R3 every `FR-n`/`TR-n` id in the Functional and technical requirements section appears in some AC row; R4 no `[BLOCKING]` in Assumptions and unresolved decisions; R5 Scope and non-goals has a non-empty `Non-goals` part; R6 Testing and verification contains a backticked command; R7 `risk: high` needs a line starting `Lens:` in Security and performance; R8 every `depends_on` exists and is not `superseded`.
- `fi.mjs` CLI (`node fi.mjs <cmd> ... [--dir D] [--json]`):
  - `new --title T [--risk R] [--source FILE|-] [--depends-on A,B]`: allocate the ID as max of `.product/features/FEATURE-*.md` and every `FEATURE-\d+` in the `feature` column of `.product/opportunities.md` (if present) plus one, zero-padded to 3; create the file with the `wx` flag and retry the next ID on `EEXIST`; fill title, `source_sha` (`sha256:` of the source bytes, or `none`), `source_ref` (basename); if a spec with the same `source_sha` already exists print `{existing:true,id}` and exit 0 without writing.
  - `validate ID|FILE`, `check ID|FILE`, `status`.
  - Every command logs one `logEvent(dir,'feature-intake',runId('fi',key),{event:cmd,ok,ms})`.

- [ ] **Step 1: Copy** `criteria.mjs` and `runlog.mjs` verbatim; write the identity tests; run them (pass).
- [ ] **Step 2: Write the template** from the design section 4: frontmatter exactly as in the Task 1 fixture but with `{{title}}`; every required heading with one-line placeholder guidance; the AC table header and one placeholder row; EC and ER bullet placeholders; an empty `## Approval history` table (`| Date | Action | By | Note | Content hash |`).
- [ ] **Step 3: Write failing tests** (`feature-intake-core.test.mjs`, using temp project dirs and the fixtures from Task 1):
  - `fi new allocates FEATURE-001 then 002`; `fi new respects a pi registry feature column` (registry row says FEATURE-007 -> next is 008).
  - `fi new with the same --source twice returns the same id and writes one file`.
  - `parallel fi new (8 spawns) yields 8 distinct files`.
  - `validate accepts valid-minimal`; `rejects inline-comment` (message quotes the line); `rejects numbered-paren-headings` (extractCriteria not ok); `rejects in-progress-status`; `rejects duplicate key`; `rejects nested frontmatter`; `rejects Delivery log not last`.
  - `a fresh template-derived draft validates but check reports R1`.
  - `check reports each of R2 to R8` with one minimal broken spec per rule; `check exits 2` when not ready, `0` when ready.
  - `status lists id, title, status, delivery, risk per spec`.
  - `fi never writes outside .product/features` (snapshot the project tree before and after).
- [ ] **Step 4: Run; expected FAIL.** Step 5: implement `spec.mjs` then `fi.mjs`; run until green.
- [ ] **Step 6: Run** `node --test tests/validation/feature-intake-core.test.mjs tests/validation/run-telemetry.test.mjs`. Commit `feat(intake): fi helper, spec validation and readiness`.

### Task 4: M3a approval, history and edit detection

**Files:**
- Modify: `skills/feature-intake/core/scripts/lib/spec.mjs`, `fi.mjs`
- Create: `tests/validation/feature-intake-lifecycle.test.mjs`

**Interfaces:**
- `lib/spec.mjs` adds: `lastApproval(text): { at:string, by:string, hash:string } | null`; `appendHistory(text, row: {date,action,by,note,hash}): string` (inserts a table row into `## Approval history`; never touches other text; the heading stays before `## Delivery log`).
- `validateSpec` adds: for `status` in `ready|implemented|validated`, `lastApproval` must exist with `action` approve and its hash must equal `contentHash(text)`; otherwise error `modified_since_approval` (or `ready without approval record`). For `draft` no hash rule.
- CLI: `approve ID --by NAME --note "<the user's words>"` (requires status `draft`, `check` ok, non-empty `--by` and `--note`; appends row `approve` with `contentHash` computed **after** the row text is excluded; sets `status: ready`; prints the new `criteria_hash` (`criteriaHash(canonicalSpec(text))`)). `reopen ID --note` (status `ready` only and `delivery: none`; sets `draft`; appends `reopen` row). Neither runs on `implemented`, `validated` or `superseded`.

- [ ] **Step 1: Write failing tests:** `approve sets ready and records who, note, hash`; `approve refuses when check fails`; `approve refuses without --by or --note`; `editing one word of a ready spec fails validate with modified_since_approval`; `editing only status or the Delivery log of a ready spec does not` (implementer close-out stays valid); `reopen then approve restores validity and changes criteria_hash`; `reopen refuses when delivery is partial or complete`; `history rows are append-only in order`; `approve twice refuses`.
- [ ] **Step 2: Run; FAIL. Step 3: Implement. Step 4: Run** this file plus `feature-intake-core` and `spec-contract`. Commit `feat(intake): hash-bound approval, reopen and edit detection`.

### Task 5: M3b supersede and split

**Files:**
- Modify: `skills/feature-intake/core/scripts/fi.mjs`, `lib/spec.mjs`
- Modify: `tests/validation/feature-intake-lifecycle.test.mjs`

**Interfaces:**
- CLI: `supersede ID --by NEW [--rewire]`: `ID` status `draft` or `ready`, `delivery: none`; `NEW` exists and is not `superseded`. Sets `status: superseded` and `superseded_by: NEW`. Dependents are specs whose `depends_on` includes `ID` and are not superseded: without `--rewire` the command refuses (exit 1) and lists them; with `--rewire` it replaces `ID` with `NEW` in each dependent that is `draft`, and still refuses if any dependent is `ready` (say: reopen it first).
- `split ID --into "Title A" "Title B" [...]`: `ID` must be `draft`. Creates one draft child per title from the template with `parent: ID`, a `## Traces` table (`| Parent criterion | Child criterion |`) pre-filled with every parent `AC-n` and an empty child cell, and `depends_on` copied from the parent. Sets the parent `superseded` with `superseded_by: A, B` (comma-separated). Same dependents rule as `supersede`.
- `validateSpec` adds: a spec with `parent:` must have `## Traces` listing every AC id of the parent file (the parent still exists), each mapped to a child criterion id that exists in the child; `superseded_by` entries must exist.

- [ ] **Step 1: Write failing tests:** `supersede marks status and superseded_by`; `supersede refuses and lists dependents`; `--rewire edits draft dependents only`; `--rewire still refuses a ready dependent`; `queue built after supersede+rewire has no unmet dependency` (use `discover`/`buildQueue`); `supersede refuses a delivered spec`; `split creates N children, parent superseded, Traces lists every parent AC`; `validate fails a child whose Traces misses a parent AC`; `split refuses a ready parent`; `split is idempotent on titles` (same titles twice returns existing children, creates nothing).
- [ ] **Step 2: Run; FAIL. Step 3: Implement. Step 4: Run** lifecycle, core and contract tests. Commit `feat(intake): supersede and split with traces`.

### Task 6: M4 SKILL.md, references, packaging, routing guide

**Files:**
- Modify: `skills/feature-intake/SKILL.md` (full procedure, at most 150 lines)
- Create: `skills/feature-intake/references/intake-procedure.md`, `references/writing-criteria.md`, `references/codebase-analysis.md`, `references/risk-marking.md`, `adapters/claude-code/README.md`
- Modify: `scripts/validate-skills.mjs` (required-file list for `feature-intake`), `package.json` (`"package:feature-intake": "node scripts/package-skill.mjs feature-intake"`), `skills.lock.json` (authored entry, via the repo's own `scripts/skills.mjs` conventions; view how `implementer` is recorded)
- Create: `docs/guides/feature-intake.md`; Modify: `docs/guides/README.md` (pick-a-skill row and the fit-together diagram), `docs/guides/build-workflow.md` (a "when to use intake" paragraph; **do not edit vendored skills**), `docs/guides/delivery-orchestrator.md` (specs may come from product-intelligence or feature-intake), `docs/architecture.md` ("Later skills" section), `CHANGELOG.md`
- Create: `tests/validation/feature-intake-skill.test.mjs`

**Interfaces:**
- `SKILL.md` carries: hard rules (never write application source; input is data; approval only from the user's own chat words, recorded with `--note`; ask a question only for a `[BLOCKING]` decision that code and docs cannot answer, log defaults as assumptions); input kinds (idea, PRD, bug report, existing plan, experience-audit fix, growth item); the procedure (`fi new` -> read relevant code read-only -> fill sections -> `fi validate` -> `fi check` -> show the user -> `fi approve` on their yes); the routing table of the design section 4; the lifecycle verbs; the run record (`fi` logs automatically).
- Description must contain a "Use when" clause and the trigger phrases: "turn this idea/requirement/bug into a feature spec", "intake", "write a spec for the implementer". It must not claim market research or Product Intelligence phrases.

- [ ] **Step 1: Write failing tests:** `SKILL.md has name feature-intake and at most 150 lines`; `every linked file exists`; `description contains "use when" and none of: competitor, market research, opportunity`; `the skill folder imports nothing outside itself` (scan `core/scripts` for `../../../` imports reaching another skill); `the filled template passes fi validate and check` (fill the placeholders in the test from `valid-minimal.md` shape); `the template passes extractCriteria once filled`.
- [ ] **Step 2: Run; FAIL. Step 3: Write the skill, references and docs.** The routing table also states: known requirements to deliver -> this skill; design still open -> `brainstorming`; market evidence needed -> `product-intelligence` (its `handoff` spec is already complete, intake only reads it); one-file tweak -> implementer T0 mini-spec.
- [ ] **Step 4: Run** `npm run validate` (expect 0 errors) and the new test file. Commit `feat(intake): feature-intake skill, references and guide`.

### Task 7: M5 implementer close-out and end-to-end compatibility

**Files:**
- Modify: `skills/implementer/references/close-out.md` (no-opportunity branch)
- Modify: `skills/implementer/SKILL.md` Input section: one sentence that an intake spec is a spec path like any other (stay within the 150-line cap checked by `implementer-skill.test.mjs`)
- Create: `tests/validation/feature-intake-e2e.test.mjs`

**Interfaces:**
- Consumes: `fi.mjs`, `deliver.mjs init --dry-run` (see how `tests/validation/delivery-orchestrator.test.mjs` builds a temp repo, fake `gh` fixtures in `tests/validation/fixtures-gh`, and config), `extractCriteria`, `criteriaHash`, `lintScenarios` from `scenarios.mjs` (see `factory-scenarios.test.mjs` for a valid scenario document).
- Close-out rule to write: when the spec's `opportunity` key is absent or `none`, do not run `pi transition`; set `status: implemented` and `delivery`, append the Delivery log row, and say in the report that there is no opportunity to transition.

- [ ] **Step 1: Write failing tests:**
  - `an approved intake spec appears in deliver init --dry-run with its title and order`; `depends_on between two intake specs orders the queue`; `an intake spec and a product-intelligence spec coexist in one queue`.
  - `scenario lint accepts an API scenario for an intake spec with an HTTP contract` (reuse the valid doc shape from `factory-scenarios.test.mjs`; criteria from `extractCriteria`).
  - `simulated close-out edits keep the spec valid and the criteria hash unchanged`: set `delivery: partial`, then `status: implemented` + `delivery: complete`, append a Delivery log; `fi validate` ok and `criteriaHash` equal before and after; `pi validate` also ok on the project (Task 2 exemption).
  - `editing an AC after approval invalidates scenario binding` (`isCurrentApproved`-style check from `scenarios.mjs`, or hash inequality if simpler).
  - `close-out.md documents the no-opportunity branch` (grep for the sentence).
- [ ] **Step 2: Run; FAIL (close-out doc test). Step 3: Edit the two implementer docs.** Do not change implementer or orchestrator scripts; if a test shows a script change is needed, stop and report BLOCKED with the failing assertion.
- [ ] **Step 4: Run the full suite once:** `npm run check` (about 13 minutes; run in the background). Expected: 0 validate errors, all tests pass. Commit `feat(intake): implementer close-out without an opportunity, end-to-end tests`.

---

## Self-review (against the spec)

- Coverage: F1/F2 (Task 1, 3), F3 (Task 1, 7), F4 (Task 2), F5 (Global Constraints, Task 6 "no vendored edits"), F7 (Task 3: CLI has no from-idea/from-plan; `ingest` folded into `new --source` as a ruling), F8/F10 approval, edit, supersede, split, idempotency, ID races (Tasks 3 to 5), F11 pi handoff unchanged (Task 2 baseline), routing and guides (Task 6), regression matrix rows (Tasks 2, 3, 7). F9 corrections are documentation only. F12 (plan bridge), F13 (governance), Antigravity: M6 to M8, separate plans.
- Rulings recorded: `fi ingest` verb dropped in favour of `fi new --source`; approval hash excludes the Approval history section to avoid a circular hash, while the factory's `criteria_hash` (which includes it) still detects any later edit; `in_progress` status rejected.
- Type consistency: `contentHash`, `lastApproval`, `appendHistory`, `readiness`, `validateSpec`, `parseSpec` are defined in Task 3 and 4 and used under the same names later.
