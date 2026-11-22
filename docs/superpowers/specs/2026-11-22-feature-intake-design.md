# Independent review of the Antigravity "Feature Intake" plan, and corrected plan

Reviewer stance: principal engineer. Every claim below was checked against the repo at `main` (c25f36f). Nothing in the repo was modified. Evidence is `file:line` or a command I ran.

## 0. Verdict

Direction is right (a dedicated intake skill, two entry paths, product-intelligence optional, no new orchestrator). **The plan as written would not work**: its own example spec would never be queued, its headings would be invisible to the factory's criteria extractor, it edits vendored skills that the lock forbids editing, and its approval model is weaker than the one it replaces. All fixable; the corrected plan is section 4.

## 1. Evidence-backed findings (ordered by severity)

### F1 (blocker). The plan's own example spec is never queued
`queue.mjs:43-51` reads frontmatter as `key: value` lines and keeps everything after the colon. The plan's schema has inline comments (`status: draft   # draft | ready | ...`).
I ran the real parser on it: `status` comes back as `"ready                # draft | ready"`, which is not `ready`, so `buildQueue` (`queue.mjs:85`) silently drops the spec. `depends_on: []` and `[FEATURE-000]` are fine (`parseDeps` strips brackets).
Rule for the schema: one `key: value` per line, no inline comments, no nested YAML, no lists other than comma-separated.

### F2 (blocker). Heading names break the factory's criteria extractor
The Phase 1 verification driver binds hidden scenarios to the spec via `criteria.mjs`. It recognises sections only by exact normalised title (`criteria.mjs:25-31`): `acceptance criteria`, `edge cases`, `error and failure scenarios` or `failure scenarios`, `http contract`. A leading number is stripped; anything else is not.
- Plan heading `6. Acceptance Criteria (Given / When / Then)` is **not** `acceptance criteria`. `7. Edge Cases and Failure Scenarios` matches neither `edge cases` nor `failure scenarios`.
- Result: `extractCriteria` returns "Acceptance criteria section has no parseable AC-<n> rows" (`criteria.mjs:370`), so `factory scenarios` refuses, and every intake spec is unverifiable.
- The plan also has no `ER-n` section and no `## HTTP contract`, so API scenarios can never be authored (`scenarios.mjs:143` requires a contract match).
- ID grammar is `AC-<n>` as table first cell, `EC-<n>` / `ER-<n>` as list bullets (`criteria.mjs:332,339`). The plan's AC table and EC bullets happen to fit; the headings do not.
Rule: the intake template reuses these exact heading titles and ID grammar. A test must feed every intake template and example through `extractCriteria` and require `ok`.

### F3 (blocker). "Zero modifications to delivery-orchestrator" is only half true
The queue reader needs only `status`, `delivery`, `depends_on`, `opportunity` (`queue.mjs:75`; `opportunity` is read, not required). But `criteria.mjs` is a second, stricter consumer (F2), and it hashes the whole spec except `status`, `delivery` frontmatter lines and a trailing `## Delivery log` (`criteria.mjs:11-14`). Consequences:
- Adding `approved_by` / `approved_at` / `in_progress` status to frontmatter is allowed only if done **before** scenarios are authored; editing them afterwards invalidates bound scenarios. `in_progress` is not in the mutable allowlist (`criteria.mjs:77`: only `draft, ready, implemented, superseded`), so the plan's extra status would be hashed and would also be an invalid status for pi (`artifacts.json` feature statuses: `draft, ready, implemented, validated, superseded`). Drop `in_progress`; `delivery: partial` already means part-built.
- The Delivery log must stay the last block of the file, as in the plan, otherwise it is hashed (`criteria.mjs` specRegions). The plan keeps it last; keep that as a validator rule.

### F4. Product-intelligence validator relaxation is feasible but the proposed rule is wrong
Plan: relax when `origin: intake` **or** `opportunity: none` **or** `opportunity` undefined. Problems:
- `pi validate` (`validate-artifacts.mjs:277-304`) runs registry linkage, product revision warnings, 19-section check and `status/BLOCKING` rules for every file in `features/`. It also rejects unexpected non-`FEATURE-NNN.md` entries (`:281`), so a sidecar file in `features/` is an error.
- Treating "opportunity undefined" as exempt makes an accidentally unlinked product-intelligence spec pass silently. Safer: exempt **only** `origin: intake`, and require `opportunity` to be absent or `none` for it; a pi spec (no `origin`, or `origin: product-intelligence`) keeps every current check.
- `frontmatter_required` in `artifacts.json:36` includes `opportunity` and `product_revision`. Change it to apply by origin, not blanket relaxation.
- pi also has a status flow keyed on opportunity (`pi transition`, `approved_without_spec`, `pi.mjs:141`); intake specs have no row, so none of that touches them. Verified by reading: `pi.mjs` only touches features through registry rows (`:243,:273,:296`).
- A cross-skill rule matters: skills must install alone (`architecture.md` "self-contained skill folder"; `validate-skills.mjs:96-104` lists required files per skill). So `feature-intake` cannot import pi's validator or frontmatter reader. Copy the small reader (same pattern as `runlog.mjs`, which is copied into four skills).
Safe decoupling = a three-line origin exemption in pi's validator + `fi validate` owning intake rules + regression tests that every existing pi fixture still produces identical output.

### F5. Plan edits vendored skills, which the lock forbids
`skills.lock.json`: `writing-plans`, `brainstorming`, `executing-plans`, `subagent-driven-development`, `finishing-a-development-branch` are `vendored`. `lockErrors` fails the build on any local edit (`skillsync.mjs:85`: "local edits not recorded"). The plan says "`writing-plans` will be enhanced" and "`finishing-a-development-branch` consolidated into implementer". Not possible without forking and re-pinning. Integration must live in **our** skills (`feature-intake`, `implementer`, guides) and call the vendored ones unchanged.

### F6. Claimed consolidations are not duplications
- `phased-review` (origin: imported, editable): the human implements and the skill tracks phases and runs review loops (`SKILL.md`, state in `reviews/progress.md`). `subagent-driven-development` dispatches implementer sub-agents. Different execution mode (you code vs agents code). Not a duplicate of SDD. Only `executing-plans` (inline) is close to it.
- `implementer` vs SDD/executing-plans: different **input** (approved spec vs a plan file), different gates (ledger and `impl pass` only by QA vs per-task reviewer), different outputs. The guide `build-workflow.md` already documents the choice table.
- `finishing-a-development-branch` is not what the implementer does: the implementer never pushes or merges unless `--pr`; the orchestrator owns PR/merge; finishing offers merge-or-PR to a human. Different owner.
- `pr-review` vs `pr-review-orchestrator`: deliberately layered, with the orchestrator skill describing itself as default and pr-review as the light pass on request. Keep both.
- `autonomous` vs `--unattended`: `autonomous` is a general zero-question mode for any task; `--unattended` is a contract between the orchestrator and implementer. Not the same.
Rule: deprecate nothing on reading alone. Decide with `si inventory` usage numbers (the roadmap already says the same).

### F7. The CLI is partly non-deterministic by design
`fi from-idea` and `fi from-plan` ("normalizes rough ideas into draft spec", "converts plan into spec") require judgement: codebase analysis, edge cases, criteria wording. A zero-dependency Node script cannot do this, and pi's pattern is the opposite: the helper owns IDs, state, gates, validation; the agent writes content.
Deterministic (CLI): `fi new` (allocate ID, write skeleton with placeholders), `fi validate`, `fi check` (readiness), `fi approve` / `fi reopen` / `fi supersede` / `fi split` (state transitions with preconditions), `fi status`, `fi ingest` (copy source text and record its hash, no interpretation).
Agent reasoning (SKILL.md procedure): turning text into a draft, codebase reading, clarification questions, criteria and edge cases.
`from-idea` / `from-plan` as CLI verbs must go; they become procedures.

### F8. Approval is weaker than the existing model
Plan: `approved_by`, `approved_at` as plain frontmatter, set by `fi decide ... approve` or "chat confirmation". pi binds approval to content: `content_hash` in PRODUCT.md and an append-only Decision Log with a sealed count (`pi.mjs:95`, `architecture.md` safety model); the factory binds scenarios and their approval to `criteria_hash` (`scenarios.mjs:58-77`). A hand-editable `approved_by` line can be forged by a builder agent and does not notice a later edit.
Need: approval record = who, when, the user's words, and the spec's content hash at approval; `fi validate` recomputes and flags `modified_since_approval`; `status: ready` with a stale hash fails validation. Detail in F10.

### F9. Smaller or unsupported claims
- `pi spec` does not exist; the command is `pi new-feature` (`pi.mjs:287`).
- `scripts/skills.mjs` is not an audit scanner; it is vendoring (`status|check|vendor|update|accept|bootstrap`). The plan says "integrated into `scripts/skills.mjs`" and then adds `scripts/audit-skills.mjs`. Repo scripts are not shipped with an installed skill, so governance there is invisible to users who install `skill-insights` alone.
- `~/.gemini/antigravity-cli/skills` does not exist on this machine (I listed it); `~/.gemini/skills` does, and `~/.gemini/antigravity-cli` holds `brain`, `conversations`, `history.jsonl`. The inventory path in the plan is an assumption; actual Antigravity skill discovery must be confirmed in the research phase.
- The Antigravity column of the compatibility table (`invoke_subagent`, `TypeName: self|research`, task artifact) matches `using-superpowers/references/antigravity-tools.md`, so that part is supported. `/sub-agent` for Claude Code is not a real mechanism; Claude Code subagents are `Agent` calls or `.claude/agents/*.md` definitions.
- "Phase 3 matrix: `finishing-a-development-branch` Consolidated" and "`test-driven-development` Mandatory" are not enforceable as written: TDD is already a hard rule inside `implementer`.
- Plan Task 7 "npm run check" is fine (`package.json:12`), but plan has no new test files registered in the repo's own test conventions; see section 6.
- The plan has no section on Path B handoff mechanics, so "Product Intelligence → Feature Intake" is a diagram arrow only (see F11).

### F10. Missing lifecycle capabilities (all absent from the plan)
| Capability | Why it is needed here | Required design |
|---|---|---|
| Edit | Any edit to a `ready` spec changes `criteria_hash` and silently invalidates hidden scenarios | `fi reopen ID` sets `status: draft`, appends a history row, clears approval; edits only allowed in `draft`; `fi approve` re-hashes |
| Approval history | One `approved_by` line loses reversals | Append-only `## Approval history` table (before Delivery log): date, action, by, user's words, content hash. Hashed (not mutable) by design, so the history cannot be rewritten without invalidating scenarios |
| Supersession | pi has `superseded`; queue treats a superseded dependency as unmet (`queue.mjs:88` errors "neither in this queue nor implemented") | `fi supersede ID --by NEW` sets `status: superseded`, `superseded_by:`; rewires dependents' `depends_on` in the same command or refuses and lists them |
| Splitting | Large intake specs routinely split | `fi split ID` creates N child drafts with `parent:` and a `## Traces` table (parent AC → child AC), then supersedes the parent. Never edits delivered work |
| Idempotency | Re-running intake on the same input must not create a second FEATURE | `fi ingest` stores `source_sha` and `source_ref`; `fi new --from-source` refuses (or returns the existing ID) when the hash is already linked; `fi new` takes `--title`-derived dedupe hint |
| ID allocation | pi allocates from files plus registry (`pi.mjs:296-297`); intake must use the same namespace or IDs collide | `fi new` allocates `max(existing files, registry feature column) + 1`. If a pi registry exists, read its feature column (read-only) |
| Concurrent runs | Two sessions allocate the same ID | Create the file with `wx` flag and retry the next ID on `EEXIST` |
| Delivered specs | Editing after `delivery: complete` is meaningless | `fi` refuses edits to `implemented` / `validated`; changes go in a new FEATURE with `depends_on` or `amends:` |

### F11. Path B handoff is unspecified and would create two spec writers
`pi handoff` writes a 19-section spec for an Approved opportunity. If intake also writes specs, two procedures and two templates produce the same file type. Smallest safe choice: **pi's handoff keeps its current output unchanged** (it is validated, fixture-tested and consumed). Feature Intake does not rewrite it. Path B = pi handoff unchanged; intake accepts an existing pi spec as already complete (`fi validate` runs in read-only mode on `origin: product-intelligence` specs to report readiness without changing them). One template per origin, shared heading titles (F2).

### F12. Plan-conversion strategy loses dependencies and traceability
A `writing-plans` plan (see `docs/superpowers/plans/2026-11-21-factory-phase-2.md`) contains Goal, Architecture, Global Constraints, Review Focus, and Task N blocks with Files / Interfaces / TDD steps. It is HOW. A feature spec is WHAT and VERIFIED BY. Problems with "convert plan to spec":
- Task dependencies are file-ownership and ordering details; the spec's `depends_on` is feature-level. Mapping tasks to `depends_on` produces wrong queue ordering.
- Test code and interfaces in the plan are implementation detail and must not be hashed as acceptance criteria.
- Superpowers plans already have a working executor (`subagent-driven-development`). Converting forces a second pipeline unless the user wants factory delivery.
Correct strategy: (1) plan to SDD directly when interactive execution is wanted (no intake); (2) for factory delivery, intake writes **one** spec per plan whose criteria are extracted from the plan's Goal, Global Constraints and Review Focus, with `source_plan:` and `source_sha:` frontmatter and a `## Traces` table linking each AC to the plan task(s) that implement it; (3) the plan file stays as the implementer's architect input (it maps to `plan.json`), referenced under Technical considerations. Never copy plan code into the spec.

### F13. Governance audit can not tell duplication from specialisation as designed
Plan: compare trigger descriptions and category keywords; flag orphans (unreferenced in guides/other skills). Counter-evidence in this repo: `pr-review` and `pr-review-orchestrator` share most vocabulary by design; `retro`, `autonomous`, `using-superpowers`, `commands/*` are entry points users invoke and nothing references them. Keyword overlap would flag exactly the pairs that are intentional and the "orphan" check would flag legitimate entry points.
Corrected: deterministic inventory (name, origin from the lock, size, description, inbound references, adapters present, last used) plus a pairwise **candidate** list scored by description and heading overlap, with a human-curated relations file (`layer-of`, `alternative-to`, `entry-point`, `uses`) that suppresses known-intentional pairs. Verdicts (merge, retire, keep) are an AI-assisted `si review` step with evidence and need user approval; the tool never deletes. Put it in `skill-insights` (installable alone, already owns inventory and usage), not a new repo script.

### F14. Over-engineering and scope
- 12 numbered sections plus delivery log plus rich frontmatter (`priority`, `created_at`, `approved_*`, `tier`): size is acceptable, but every required field the factory does not read is a validation burden. Required set should be what a consumer reads.
- `fi from-plan`, `fi from-idea`, `fi ready`, `fi status`, `fi new`, `fi validate` as six verbs is fine only after F7 trimming.
- A JSON Schema for a Markdown spec adds a second source of truth beside the heading list. pi uses `artifacts.json` (list of required sections, statuses); do the same.
- `docs` updates to four files and a new guide are fine; "Task 7: run full validation" is not a task.

## 2. Accepted, modified, rejected, missing

| Proposal | Decision | Note |
|---|---|---|
| New `feature-intake` skill, standard shape (SKILL.md, core, references, templates, adapters) | **Accept** | Matches `architecture.md`; copy small helpers, no shared code |
| Two entry paths; product-intelligence optional | **Accept** | Matches your non-negotiables |
| Write to `.product/features/FEATURE-NNN.md` | **Accept** | Queue and implementer need nothing else (F3) |
| Relax pi validator | **Modify** | Exempt `origin: intake` only; keep all pi checks for everything else; regression-test (F4) |
| Canonical 12-section schema | **Modify** | Reuse factory-recognised heading titles and ID grammar; add `ER` and optional `HTTP contract`; no inline comments (F1, F2) |
| Frontmatter `status: in_progress` | **Reject** | Not an allowed status in pi or the hash allowlist; `delivery: partial` covers it |
| `approved_by` / `approved_at` plain frontmatter | **Modify** | Hash-bound approval record plus append-only history (F8, F10) |
| `fi from-idea`, `fi from-plan` CLI verbs | **Reject as CLI** | Become agent procedures; CLI gets `ingest` for source capture (F7) |
| Plan to spec conversion | **Modify** | One spec per plan, criteria from Goal/Constraints/Review Focus, `## Traces`, plan referenced not copied (F12) |
| Deprecate `phased-review`, consolidate `finishing-a-development-branch` | **Reject now** | Different modes; decide from `si inventory` numbers; vendored skills cannot be edited (F5, F6) |
| Enhance `writing-plans` | **Reject** | Vendored. Put any bridging logic in `feature-intake` (F5) |
| `scripts/audit-skills.mjs` | **Modify** | Move to `skill-insights` as `si inventory --overlaps` plus relations file (F13) |
| T0 to T3 triage diagram | **Accept as documentation only** | Already implemented in `implementer`; do not restate as new policy |
| Antigravity adapter README | **Accept, after research** | Skill discovery path must be verified first (F9) |
| `docs/guides/feature-intake.md` and updates to build-workflow, delivery-orchestrator, architecture | **Accept** | |
| Brainstorming / writing-plans classified "conditional upstream" | **Modify** | Routing table lives in the new skill and the guide; vendored skills untouched |
| Edit, supersede, split, approval history, idempotency, ID races | **Missing, add** | F10 |
| Path B handoff mechanics | **Missing, add** | F11 |
| Regression and compatibility test matrix | **Missing, add** | section 6 |
| Risk-based reviews triggered from spec content | **Missing, add small** | `risk:` frontmatter (`low|elevated|high`) set by intake, mapped to implementer tier hint and the orchestrator's T3 hold; never lowers existing protections |
| Metrics for "is intake actually used" | **Missing, add** | `.skill-runs` logging (copied `runlog.mjs`) so `si` reports intake runs; no new telemetry |

## 3. Design decisions that need your call (not mine)

1. Feature-intake validator scope: confirm "exempt `origin: intake` only" (recommended) versus allowing `opportunity: none` on any spec.
2. Keep the implementer's one-page mini-spec for T0/T1, or route every raw idea through intake? Recommended: keep mini-spec for T0/T1 asks; intake for anything that should be queued or verified by the factory.
3. Required frontmatter beyond the queue's keys: recommended minimum is `type, id, title, status, origin, risk, depends_on, delivery, source_sha`. `priority` optional.
4. Antigravity adapter: milestone 1 or after research? Recommended after research (F9).

## 4. Corrected target architecture

```
                        ┌──────────────────────────────────────────────┐
 rough idea / PRD /     │  feature-intake  (new skill, no orchestrator)  │
 bug / plan / audit fix ─►  agent procedure + deterministic `fi` helper   │
                        │  new, ingest, validate, check, approve,       │
                        │  reopen, supersede, split, status             │
                        └───────────────┬──────────────────────────────┘
                                        │ writes .product/features/FEATURE-NNN.md
   product-intelligence (optional)      │   origin: intake
   init→research→opportunities→handoff ─┤   origin: product-intelligence (unchanged writer)
                                        ▼
                      one spec contract (shared headings + AC/EC/ER grammar)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
 implementer (interactive)     delivery-orchestrator            factory driver
 spec path, tiers T0–T3        queue reads frontmatter          criteria.mjs hashes + extracts
                               unchanged                        scenarios bound to criteria_hash
```

Principles encoded:
- **One spec contract, two writers.** Heading titles, `AC-n/EC-n/ER-n`, `## HTTP contract`, trailing `## Delivery log`, and the frontmatter keys the queue reads are the contract. Writers: pi handoff (19 sections, unchanged) and intake (smaller set). `fi validate` and pi's validator both enforce the contract part; each enforces its own extras.
- **CLI owns state and gates; the agent owns content** (F7).
- **Approval is a hash-bound record** (F8); the factory's scenario binding stays the second line of defence.
- **No change to vendored skills**; routing lives in intake and the guides.
- **Risk is data, not a new gate:** `risk` and `tier` hints flow to the implementer; the orchestrator's T3 hold and every safeguard stay as is.

### Spec schema (corrected)
Frontmatter (no comments, one `key: value` per line):
`type: feature-spec` · `id: FEATURE-NNN` · `title` · `status: draft|ready|implemented|validated|superseded` · `origin: intake|product-intelligence` · `risk: low|elevated|high` · `depends_on: FEATURE-001, FEATURE-002` (comma list or empty) · `delivery: none|partial|complete` · `source_sha: sha256:...` (intake input hash) · optional `source_ref`, `source_plan`, `priority`, `parent`, `superseded_by`, `amends`.

Body, in order (titles exact where marked **[F]**, factory-recognised):
1. Context and problem statement
2. Objective and expected behavior
3. Existing implementation analysis (paths, patterns, integration points; read-only evidence)
4. Scope and non-goals
5. Functional and technical requirements (table with IDs `FR-n`, `TR-n`)
6. **Acceptance criteria [F]** (table, first cell `AC-n`, Given/When/Then, a "Covers" column)
7. **Edge cases [F]** (`- EC-n: case → expected behavior`)
8. **Error and failure scenarios [F]** (`- ER-n: failure → expected behavior`)
9. **HTTP contract [F]** (optional, backticked `METHOD /path` per line)
10. Technical considerations (API, database, authn/authz, dependencies)
11. Security and performance
12. Testing and verification (commands, mapped to AC ids)
13. Assumptions and unresolved decisions (`[BLOCKING]` marks)
14. Traces (only for split or plan-derived specs)
15. Approval history
16. Delivery log (**last block**, unchanged grammar)

Readiness (`fi check`, mechanical, never a new status): no placeholders; AC table parses via `extractCriteria` with `ok`; every FR/TR covered by at least one AC; every `[BLOCKING]` resolved; non-goals present; verification command named; `risk: high` requires a recorded security or database lens note; `depends_on` resolves. Readiness result is `ready-to-approve`; **only the user's `fi approve --by NAME --note "<their words>"` sets `status: ready`**, writing the hash into the approval history.

### Routing (guide and SKILL.md, no code)
| Situation | Use |
|---|---|
| Know what to build, want it factory-delivered or verified | feature-intake → implementer or delivery-orchestrator |
| Know what to build, want to chat through design | brainstorming → writing-plans → SDD or executing-plans (existing) |
| Not sure what to build, need market evidence | product-intelligence → handoff spec (unchanged) |
| One-file tweak | implementer T0 mini-spec (unchanged) |

## 5. Revised implementation sequence and backlog

Each milestone is independently shippable and leaves `npm run check` green. Order is chosen so the riskiest assumption (the spec contract) is proven first.

### M0. Contract pinning (no new skill)
Goal: prove what the downstream consumers actually need before writing a template.
- Write `tests/validation/spec-contract.test.mjs` that feeds candidate specs through `queue.discover`/`buildQueue`, `criteria.extractCriteria` and `pi validate`.
- Add negative fixtures: inline-comment frontmatter (F1), numbered-parenthesis headings (F2), `in_progress` status.
- Acceptance: a minimal valid intake spec is queued, extracted `ok`, and an inline-comment spec is demonstrably rejected by `fi validate` later; no production code changed.
- Risk: none.

### M1. pi validator origin exemption
- Modify `validate-artifacts.mjs` and `artifacts.json`: for `origin: intake`, require `type,id,status,origin`, filename match, `opportunity` absent or `none`; skip registry, section and product-revision checks. Everything else identical.
- Acceptance: all existing pi fixtures and tests produce byte-identical results; a pi spec with a missing opportunity still errors; an `origin: intake` spec passes `pi validate`; an `origin: intake` spec naming an opportunity errors.
- Regression: `artifacts.test.mjs`, `gates.test.mjs`, `review*.test.mjs`, `source-protection.test.mjs`, `repo.test.mjs`.

### M2. `feature-intake` core helper (`fi.mjs`)
- Verbs: `new`, `ingest`, `validate`, `check`, `status`. Copy `fm.mjs` and `runlog.mjs`. Allocation via exclusive create, shared namespace with pi (F10).
- Acceptance: concurrent `fi new` never collides; `fi ingest` of the same source returns the same ID; `fi validate` passes the M0 positive fixture and fails each negative fixture with a specific message; `fi check` reports every unmet readiness rule.
- No AI, no network, zero dependencies.

### M3. Approval and lifecycle
- Verbs: `approve`, `reopen`, `supersede`, `split`. Approval history table, content hash, `modified_since_approval` detection, dependents rewired or refused.
- Acceptance: editing a ready spec makes `fi validate` fail until `reopen`/`approve`; supersede refuses while an in-queue dependent exists unless rewired; split produces children whose AC traces cover every parent AC; delivered specs reject edits; the factory's `criteria_hash` changes exactly when it should.

### M4. Skill, template, references
- `SKILL.md` procedures for Path A and ingestion of idea, PRD, bug, plan, audit-fix, growth item; clarification rule (ask only when a `[BLOCKING]` decision cannot be grounded in code or docs); template with the exact headings; references (criteria writing, codebase analysis, risk marking).
- Add to `validate-skills.mjs` required-file list, `package.json` `package:feature-intake`, `skills.lock.json` (authored), `docs/guides/feature-intake.md`.
- Acceptance: `npm run validate` 0 errors; description triggers on the intake phrases and not on product-intelligence phrases (trigger test in the style of `skill-frontmatter.test.mjs`); template passes `extractCriteria` once placeholders are filled.

### M5. Implementer and orchestrator integration (docs and small code)
- `implementer/references/close-out.md`: when `opportunity` is absent or `none`, skip `pi transition`; set `status: implemented`, `delivery: complete`, log row. Add a test beside `implementer-skill.test.mjs`.
- `deliver.mjs` close: no change expected; add an integration test that a full queue run (fake `gh`, existing fixtures) delivers an intake spec.
- Acceptance: end-to-end test with an intake spec through `deliver init --dry-run` and the factory benchmark app (`bench/factory/app`) reaches the same verdict path as a pi spec.

### M6. Plan bridge
- Procedure in `SKILL.md` (not code): one spec per plan, `source_plan`, `source_sha`, `## Traces`. `fi validate` checks that `source_sha` matches the plan file when present (warn if the plan changed).
- Acceptance: run it on the real Phase 2 plan; produce a draft whose ACs extract `ok` and whose Traces table references real task numbers; the spec contains no copied plan code.

### M7. Governance in skill-insights
- `si inventory --overlaps` using description and heading similarity, a `relations` file for intentional layering, orphan check that excludes declared entry points. Output is candidates with evidence; never deletes.
- Acceptance: on this repo it does **not** flag `pr-review` vs `pr-review-orchestrator` once the relation is declared, flags a seeded duplicate pair in a fixture, and lists the actual unused skills from sample transcripts. Antigravity transcript reading only after research confirms its format.

### M8. Cross-platform, after research
- Verify Antigravity skill discovery path, subagent and hook model from first-party docs; then write `adapters/antigravity/README.md` and, only if supported, native role files generated from `core/roles/roles.json`.
- Acceptance: the Antigravity README makes no claim that is not cited; a smoke run of intake on Antigravity is recorded (or the gap is documented as unverified).

### Deferred
Deprecations (`phased-review`, `pr-review`) until `si inventory` shows low use over at least 20 sessions. Any edit to vendored skills.

## 6. Backward-compatibility and regression requirements

| Area | Requirement | Test |
|---|---|---|
| pi validator | Every existing fixture yields identical errors and warnings before and after M1 | Snapshot comparison against `tests/fixtures/expected/*`, plus `artifacts.test.mjs` unchanged |
| pi workflow | `pi new-feature`, `transition`, `decide`, `handoff` unchanged; pi specs still need an opportunity | `gates.test.mjs`, `review2/3.test.mjs`, `modes.test.mjs` |
| Queue | Intake and pi specs coexist; dependency order across origins; superseded dependency handling | New `spec-contract` and `feature-intake-queue` tests; `delivery-orchestrator.test.mjs` unchanged |
| Factory | `extractCriteria` ok on every intake template and example; scenarios authored against an intake spec stay valid after Delivery log and `status`/`delivery` changes, invalid after any other edit | `factory-scenarios.test.mjs`, `factory-verify.test.mjs`, new intake cases |
| Implementer | Close-out works with and without an opportunity | `implementer-skill.test.mjs` addition |
| Skill packaging | New skill installs alone: no import from another skill's folder; required-file list | `validate-skills.mjs`, `skill-frontmatter.test.mjs`, `install-agents-symlink.test.mjs` pattern |
| Lock | No vendored file touched | `skills-sync.test.mjs`, `lockErrors` |
| Telemetry | Intake runs logged in the existing run-log format; `si` still parses | `run-telemetry.test.mjs`, `skill-insights.test.mjs` |
| Safety | Intake never writes application source; spec content is data, not instructions (an injected instruction in a source document must not be followed) | Fixture in the style of the product-intelligence injected README |
| Full suite | `npm run check` green; no new network use | CI |

Note: the full suite takes about 13 minutes; milestones should run the touched tests first and the whole suite once per milestone.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Contract drift between `fi`, pi and the factory | M0 contract test is the single gate; any change to heading titles fails it |
| Approval hash invalidates scenarios unexpectedly | Approval before scenario authoring is the documented order; `fi approve` prints the new `criteria_hash` |
| Two writers confuse users | One routing table (section 4); pi handoff unchanged |
| Intake over-asks questions | Rule: ask only for `[BLOCKING]` decisions that code and docs cannot ground; log defaults as assumptions |
| Plan bridge quality | M6 acceptance runs on a real plan; marked procedure, not automation |
| Scope growth | M7 and M8 are separable; M0 to M5 deliver Path A end to end |

## 8. What I did not verify

Antigravity's real skill discovery, hooks and subagent API beyond what `antigravity-tools.md` says; any external prior art (the brief's research phase); real behaviour of intake with a live agent (nothing is built); the factory scenario author's treatment of specs lacking an HTTP contract beyond reading `scenarios.mjs`.
