# Factory Phase 1a (Verification gate: driver, isolation, API checks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-LLM factory driver that builds each feature in a restricted `claude -p` builder session, verifies it against hidden API scenarios it runs itself in an untrusted-code sandbox, and merges only the exact commit that carries a passing verdict, enforced on GitHub by a `factory/verified` status.

**Architecture:** New pure libs in `skills/delivery-orchestrator/core/scripts/lib/` (`criteria`, `scenarios`, `apicheck`, `antigaming`, `verdict`, `sandbox`, `sessions`, `gitsafe`), a new driver `core/scripts/factory.mjs`, and targeted changes to `deliver.mjs` (states, merge rule, queue path, `retry --note`). LLM roles (builder, scenario author) run as separate `claude -p` processes with their own settings; the driver alone sees scenarios and verdicts under `FACTORY_HOME`.

**Tech Stack:** Node.js 20+ ESM, zero dependencies, `node:test`, real git with a bare origin, fake `gh` (`tests/validation/fixtures-gh/gh.mjs`), a new fake `claude` script for tests, macOS `sandbox-exec` for the untrusted-code sandbox.

**Spec:** [docs/factory/specs/phase-1-verification-gate.md](../../factory/specs/phase-1-verification-gate.md) (parts marked 1a). Phase 0 facts it relies on: [docs/factory/spikes/limit-detection.md](../../factory/spikes/limit-detection.md), [docs/factory/spikes/sandbox-deny.md](../../factory/spikes/sandbox-deny.md).

## Global Constraints

- Zero runtime dependencies; Node 20+; ESM. Every external command runs as an argument list without a shell.
- `FACTORY_HOME` = `process.env.FACTORY_HOME || ~/.factory`; `repo-key` = `nameWithOwner` with `/` → `__`. Tests always set `FACTORY_HOME` to a temp dir.
- Trusted refs are always fully qualified: `refs/remotes/origin/<branch>` (never `origin/<branch>`).
- Every driver git call runs with `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=ssh` (via `lib/gitsafe.mjs`).
- All policy (verification, merge, autonomy-relevant keys, commands) is read from the committed `.product/delivery.json` on `refs/remotes/origin/<base>` on every command that acts on it; the queue file is state only.
- The driver never executes code from a feature branch outside the untrusted-code sandbox; if the sandbox is unavailable, it refuses (no silent fallback).
- Nothing the builder can read (its session output, files in the clone, PR text, `deliver` command output) ever contains scenario text, scenario data, scenario ids, verdict evidence or the canary.
- `claude -p` sessions: `--output-format stream-json --verbose`, `--max-turns`, wall-clock timeout, `--setting-sources` restricted, `--strict-mcp-config`, stdin closed (`</dev/null` equivalent). Author sessions get their own `CLAUDE_CONFIG_DIR` under `FACTORY_HOME`.
- Existing tests must keep passing; the T3 merge test is updated to the new rule. `runlog.mjs` stays byte-identical. `SKILL.md` stays under 500 lines (detail in `references/verification.md`, `references/factory-driver.md`).
- Default `verification.required` is `false`: interactive behaviour is unchanged unless a repo opts in.

## Review Focus

1. **Builder edits `.product/delivery.json` or `.claude/settings.json` in its PR** (config injection): held by G4 before verification, and the driver still reads policy from `refs/remotes/origin/<base>`. Test in Task 5 and Task 11.
2. **Canary or scenario strings leaking through the symptom brief** (the evaluator/API failure text quotes request paths or data): the brief contains only criterion IDs and sanitised text. Test in Task 9.
3. **A push after verification** (the builder or anyone pushes to the PR branch after `verified`): merge refuses because the verdict sha no longer matches the head. Test in Task 10.
4. **Driver killed mid-feature, then restarted**: resumes by state without a double build, a lost commit or a leftover app process holding the port. Test in Task 11.
5. **Sandbox unavailable** (non-macOS, or `sandbox-exec` missing): verification refuses with a clear message instead of running untrusted code unsandboxed. Test in Task 6.

---

### Task 1: Config `verification` keys and queue path

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/config.mjs`, `deliver.mjs` (queue location)
- Modify: `templates/delivery.json` (keep `verification` absent), `references/config.md`
- Test: `tests/validation/factory-verify.test.mjs` (new)

**Interfaces:**
- Produces: `defaults().verification = { required: false, scenario_approval: 'auto', session_timeout_s: { builder: 1800, author: 900 }, max_turns: { builder: 200, author: 40 }, model: { builder: null, author: null }, test_globs: [] }` (evaluator keys arrive in 1b; unknown keys under `verification` are errors).
- Produces: `deliver.mjs` honours `DELIVER_QUEUE` env (absolute path) for the queue file; PR body files stay under `<root>/.delivery/`. Default unchanged.

- [ ] **Step 1: Failing tests:** parse defaults; `scenario_approval` only `auto`|`human`; timeouts 60–7200; turns 5–1000; `test_globs` list of ≤50 strings; unknown key rejected; `DELIVER_QUEUE` set → queue written there and not in `.delivery/queue.json`.
- [ ] **Step 2:** Run `node --test tests/validation/factory-verify.test.mjs` — expect FAIL.
- [ ] **Step 3:** Implement in `config.mjs` (follow the existing strict style) and the queue path in `deliver.mjs`.
- [ ] **Step 4:** Run the file and `tests/validation/delivery-orchestrator.test.mjs` (background) — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): verification config keys and relocatable queue`

### Task 2: States, fix from `verify_failed`, T3 rule, `retry --note`

**Files:**
- Modify: `core/scripts/lib/queue.mjs` (`TRANSITIONS`, `ACTIVE`), `deliver.mjs` (`fix`, `merge`, `retry`)
- Modify: `references/states.md`
- Test: `tests/validation/factory-verify.test.mjs`; update the existing T3 merge test in `delivery-orchestrator.test.mjs`

**Interfaces:**
- Produces: `TRANSITIONS` adds `ci_passed → verified | verify_failed`; `verify_failed → fixing | blocked`; `verified → merged | pr_open | awaiting_human | blocked`. `ACTIVE` adds `verified`, `verify_failed`.
- Produces: `deliver fix ID` accepts `verify_failed` (shares `max_fix_rounds`).
- Produces: `deliver merge ID` accepts `verified` (and `ci_passed` only when `verification.required` is false on the base config); T3 merges only with `--merge-t3`/`allow_tier3` **and** a passing verdict file (Task 8 provides `readVerdict`); without one, hold for a person.
- Produces: `deliver retry ID --note "<reason>"` (from `awaiting_human` held by G1/G4/G5) records the note on the feature (`f.override_note`) and returns it to `pr_open`.

- [ ] **Step 1: Failing tests:** each new transition allowed and a forbidden one refused (`verify_failed → merged`); `fix` from `verify_failed` increments `fix_rounds`; T3 with `--merge-t3` and no verdict → `awaiting_human`; `retry --note` sets the note and moves to `pr_open`; `retry` without `--note` on a G-hold is refused.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement. For the T3 verdict lookup, import `readVerdict` lazily from `lib/verdict.mjs` (Task 8); until it exists, a stub module in this task returning `null` is acceptable and is replaced in Task 8.
- [ ] **Step 4:** Run this file and the delivery tests — expect PASS (only the T3 test changes, deliberately).
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): verification states, fix from verify_failed, T3 needs a verdict, retry --note`

### Task 3: Spec template IDs and criteria extraction

**Files:**
- Modify: `skills/product-intelligence/templates/feature-specification.md` (EC-n / ER-n IDs; optional `## HTTP contract` section)
- Create: `skills/delivery-orchestrator/core/scripts/lib/criteria.mjs`
- Test: `tests/validation/factory-scenarios.test.mjs` (new)

**Interfaces:**
- Produces: `extractCriteria(specText: string) -> { ac: Array<{id, text}>, ec: Array<{id, text}>, er: Array<{id, text}>, contract: Array<{method, path}>, sections: string }` — reads the acceptance-criteria table, edge-case and failure lists (IDs `AC-n`, `EC-n`, `ER-n`), and the HTTP contract (lines like `` `GET /api/projects` ``); `sections` is the normalised text of those sections only (whitespace collapsed, trailing spaces removed).
- Produces: `criteriaHash(sections: string) -> 'sha256:<hex>'`.
- Produces: `specFromBase(git, base, specPath) -> string|null` reading `refs/remotes/origin/<base>:<specPath>`.

- [ ] **Step 1: Failing tests:** a template-shaped spec yields the IDs and contract; editing the close-out or status section does not change `criteriaHash`; editing an AC text does; specs without EC/ER yield empty arrays; a spec read from a local branch named `origin/main` is ignored (qualified ref).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat: spec template EC/ER IDs and HTTP contract; criteria extraction and hash`

### Task 4: Scenario files: schema, lint, storage, approval

**Files:**
- Create: `core/scripts/lib/scenarios.mjs`
- Test: `tests/validation/factory-scenarios.test.mjs`

**Interfaces:**
- Consumes: Task 3 `extractCriteria`, `criteriaHash`; Phase 0 `factoryHome`, `repoKey`, `writeJsonAtomic`, `readJson`.
- Produces: `scenarioPath(repoKeyStr, featureId) -> string` = `FACTORY_HOME/scenarios/<repo-key>/<ID>.json`.
- Produces: `lintScenarios(doc, criteria, currentHash) -> { ok: boolean, problems: string[] }` — problems name IDs and counts only; rules exactly as the spec's Coverage lint (every AC/EC/ER covered; 1–3 scenarios per criterion; api scenarios need `request`+`assert`, ui need `steps`+`expect`; `kind: api` only for contract endpoints (method + path without query); canary present in scenario data; `criteria_hash` current).
- Produces: `newCanary() -> 'fx-' + 6 hex`; `scenariosHash(doc) -> 'sha256:<hex>'` (canonical JSON).
- Produces: `approve(doc, by) -> doc` (sets `approved: { by, at }`); `isCurrentApproved(doc, currentHash) -> boolean`.

- [ ] **Step 1: Failing tests** for each lint rule (one passing doc, one failing doc per rule), canary format, hash stability under key reordering, approval round-trip, path under temp `FACTORY_HOME`, problems never contain scenario text (assert a problem list for a doc whose data contains `SECRET-DATA` has no such string).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): hidden scenario format, lint and approval`

### Task 5: Anti-gaming checks G1–G5

**Files:**
- Create: `core/scripts/lib/antigaming.mjs`
- Test: `tests/validation/factory-antigaming.test.mjs` (new)

**Interfaces:**
- Consumes: a git runner (`lib/gitsafe.mjs` from Task 6, or a passed-in `git` function).
- Produces: `checkDiff({ git, baseRef, headSha, config, specPaths }) -> Array<{ id: 'G1'|'G2'|'G3'|'G4'|'G5', files: string[] }>` — computed from `git diff -z --no-renames <baseRef>...<headSha>` and added lines only (`--unified=0`), never executing code. Patterns and protected paths are exactly the spec's P1.3 table; test-file patterns `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, `__tests__/`, `tests/` plus `verification.test_globs`; G4 includes `.product/delivery.json`, `.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.gitattributes`, `.gitmodules`, CI paths, test configs (`jest.config.*`, `vitest.config.*`, `pytest.ini`, `pyproject.toml` `[tool.pytest]` hunks, `.mocharc*`) and changes to the `scripts` keys of `package.json` named by `tests.all` or `local_checks`.
- Produces: `classify(hits, stage: 'built'|'merge') -> 'clean' | 'fix' | 'hold'` per the table (G2/G3 at built → `fix`; G1/G4/G5 at built → `hold` at `pr_open`; any hit at merge → `hold`).

- [ ] **Step 1: Failing tests** (real git repo fixture): each G fires on a minimal diff and does not fire on a near-miss (e.g. `skip` in a comment in a non-test file for G2 is still matched only when it is `.skip(`; a renamed test file counts as modified); `package.json` change to an unrelated key is not G4; added-lines-only (a pre-existing `.only(` is ignored); `classify` table.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): anti-gaming diff checks G1-G5`

### Task 6: Hardened git and the untrusted-code sandbox

**Files:**
- Create: `core/scripts/lib/gitsafe.mjs`, `core/scripts/lib/sandbox.mjs`
- Test: `tests/validation/factory-sandbox.test.mjs` (new)

**Interfaces:**
- Produces: `gitSafe(cwd, ...args) -> {code,out,err}` always prefixing `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=ssh`.
- Produces: `sandboxAvailable() -> { ok: boolean, reason?: string }` (darwin with `/usr/bin/sandbox-exec`).
- Produces: `sandboxProfile({ writable: string[], network: 'registries'|{ localhostPort: number }|'none' }) -> string` — SBPL that allows reads, denies writes except `writable` (realpaths) and the per-run temp dir, denies reads of `FACTORY_HOME` except nothing, and limits network accordingly (registries: outbound TCP 443/80 to any host; run: `localhost:<port>` only).
- Produces: `runSandboxed(argv, { cwd, env, timeoutS, profile }) -> Promise<runCmd result>` and `startSandboxed(argv, opts) -> app` — wrap Phase 0 `runCmd`/`startApp` with `['/usr/bin/sandbox-exec', '-p', profile, ...argv]`.

- [ ] **Step 1: Failing tests:** `gitSafe` ignores a planted `.git/hooks/post-checkout` that would create a marker; on macOS, a sandboxed `node -e` cannot write outside `writable` (EPERM), cannot read a file under the temp `FACTORY_HOME`, and with `{localhostPort}` cannot connect to a second local port; `sandboxAvailable()` false on non-darwin (simulate via injected platform) and the caller refuses (Review Focus 5). Skip the macOS-only tests with a clear message elsewhere.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): hardened git calls and an untrusted-code sandbox`

### Task 7: `claude -p` sessions and the builder/author roles

**Files:**
- Create: `core/scripts/lib/sessions.mjs`, `core/settings/builder.json`, `core/settings/author.json`, `core/prompts/scenario-author.md`
- Create: `tests/fixtures/fake-claude/claude.mjs` (+ `claude` shim)
- Modify: `skills/implementer/SKILL.md` (`--fix-brief <file>`; always write `.implementation/<ID>/result.json` `{status:'done'|'blocked', question, summary}` in `--unattended`)
- Test: `tests/validation/factory-sessions.test.mjs` (new)

**Interfaces:**
- Consumes: Phase 0 `classifyFailure` (`lib/limits.mjs`), proc helpers.
- Produces: `runSession({ role: 'builder'|'author', cwd, prompt, settingsFile, configDir?, maxTurns, timeoutS, model? }) -> Promise<{ ok, sessionId, result, usage: {in,out,cache_create,cache_read}, turns, failure: null|{kind, resetAt}, timedOut }>` — spawns `claude -p <prompt> --output-format stream-json --verbose --max-turns N --settings <file> --setting-sources user --strict-mcp-config` (+ `--model` if set), stdin ignored, parses the stream line by line (last `result` event), classifies `is_error` results with `classifyFailure`, kills the group on timeout.
- Produces: `readBuilderResult(cloneDir, id) -> { status: 'done'|'blocked', question?, summary? }` — missing/malformed → `{ status: 'blocked', question: 'no_result' }`.
- Settings files: builder = candidate A from `sandbox-deny.md` (Read/Edit deny for `FACTORY_HOME`, `~/.claude*/projects`, `.git/config`, `.git/hooks`; Bash deny `gh *`, `git push*`, `node *factory.mjs*`, `node *deliver.mjs*`; `sandbox.enabled`, `allowUnsandboxedCommands:false`, `failIfUnavailable:true`, `filesystem.denyRead` for `FACTORY_HOME`; WebFetch/WebSearch denied; `disableAllHooks:true`). Author = no tools except none (`--tools ""` style per `--help`), WebFetch denied. Exact keys follow the spike doc; anything it marks unverified is listed in `references/factory-driver.md` as a known gap.

- [ ] **Step 1: Failing tests** with the fake `claude` (env-driven behaviours: `done`, `blocked`, `no-result`, `malformed-stream`, `timeout`, `usage-limit` (an `is_error` result with session-limit text), `rejected-rate-event`): result/usage/session id parsed; timeout kills the process; usage limit classified `session`; argv contains every required flag; stdin is not inherited; `readBuilderResult` cases.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): claude -p session runner, builder and author roles`

### Task 8: API check engine and verdicts

**Files:**
- Create: `core/scripts/lib/apicheck.mjs`, `core/scripts/lib/verdict.mjs`
- Test: `tests/validation/factory-verify.test.mjs`

**Interfaces:**
- Produces: `jsonPath(obj, expr) -> any[]` supporting `$`, `.key`, `[n]`, `[*]` only (anything else throws `unsupported json_path`).
- Produces: `runApiScenario(scenario, baseUrl, { fetchImpl = fetch }) -> Promise<{ status: 'pass'|'fail'|'blocked', failed?: string }>` — setup requests (non-2xx → `blocked`), request, assertions (`status`, `header`, `json_path` with `equals|contains|not_contains|count|matches`); `failed` names the assertion kind only (no values).
- Produces: `verdictPath(repoKey, id, sha)`, `writeVerdict(doc)`, `readVerdict(repoKey, id, sha) -> doc|null`, and `verdictMatches(doc, { sha, scenariosHash, criteriaHash }) -> boolean`. Verdict doc: `{ feature, sha, scenarios_hash, criteria_hash, results: [{ id, covers, status, flaky }], verdict: 'pass'|'fail', at }`.
- Replace Task 2's stub with the real `readVerdict`.

- [ ] **Step 1: Failing tests** against a tiny local HTTP fixture server: each assertion kind pass/fail; setup failure → `blocked`; unsupported path → error; `failed` text contains no request path, header value or body; verdict round-trip and `verdictMatches` false on any hash or sha change; T3 test from Task 2 now passes with a real passing verdict.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): API scenario checks and verdict files`

### Task 9: Verification step and symptom brief

**Files:**
- Create: `core/scripts/lib/verify.mjs`
- Modify: `tests/validation/fixtures-gh/gh.mjs` (commit statuses: `api repos/o/r/statuses/<sha>` POST, `api repos/o/r/commits/<sha>/status`; `pr edit --body-file`)
- Test: `tests/validation/factory-verify.test.mjs`

**Interfaces:**
- Consumes: Tasks 3, 4, 6, 8; Phase 0 readiness helpers (`gitWorktree`, `allowEnv`, `waitReady`, `stopApp`, `portInUse`).
- Produces: `verifyFeature({ repoKey, id, sha, baseRef, config, scenarios, criteriaHash, git }) -> Promise<{ verdict, brief: string[] }>` — creates `FACTORY_HOME/work/<repo-key>/<ID>-<sha>/` worktree at `sha`; refuses if `sandboxAvailable()` is false; runs `app.setup` sandboxed with registries network; for each API scenario: stop app, `app.seed`, start app sandboxed with `{localhostPort}`, `waitReady`, run the scenario twice (pass only if both pass); always stops the app and removes the worktree; before starting, confirms nothing listens on the port; writes the verdict (reuses an existing matching verdict without running).
- Produces: `symptomBrief(failures, scenarios, canary) -> string[]` — per failure: `<covers IDs>: an endpoint returned an unexpected status or body`; never includes ids, paths, data, the canary, quoted strings or URLs (sanitiser applied even to this fixed text's inputs).
- Produces: `postVerified({ gh, repo, sha, n })` → status `factory/verified` success + PR body line `Verified: N/N scenarios at <short sha>` (scenario count only).

- [ ] **Step 1: Failing tests:** a fixture app with one correct and one wrong endpoint → verdict fail with covers of the wrong one; brief lines contain only `AC-`/`EC-`/`ER-` IDs and the fixed sentence (Review Focus 2: assert the canary, every scenario path and data string are absent); verdict reuse skips running; app always stopped and worktree removed on thrown errors; port pre-occupied → refuse; `postVerified` calls the fake gh with the right sha and no scenario text in the body.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): sandboxed API verification, verdicts and symptom briefs`

### Task 10: Verdict-bound merge

**Files:**
- Modify: `deliver.mjs` (`merge`), `references/safety.md`
- Test: `tests/validation/factory-verify.test.mjs`

**Interfaces:**
- Consumes: Task 8 `readVerdict`, `verdictMatches`; Task 5 `checkDiff`, `classify`; Task 3 `criteriaHash`; Task 4 `scenariosHash`.
- Produces: when the base config says `verification.required: true`, `deliver merge ID` requires state `verified`, a verdict for the exact head sha with `verdict: pass` and matching `scenarios_hash` and `criteria_hash` (recomputed now from `FACTORY_HOME` and `refs/remotes/origin/<base>`), and `classify(checkDiff(..), 'merge') === 'clean'`; otherwise it holds (`awaiting_human`) with a category reason. Policy is re-read from the base config inside `merge` (a forged queue `policy` has no effect).

- [ ] **Step 1: Failing tests:** happy path merges; a push after verification (head moved) → hold, not merge (Review Focus 3); scenario file changed after verification → hold; G4 change on the merge sha → hold; forged `q.policy.verification.required=false` in the queue with base config `true` → still requires a verdict; base config `required:false` → `ci_passed` merges as before.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (and the delivery tests in the background).
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): merge only a verified sha when verification is required`

### Task 11: The factory driver

**Files:**
- Create: `core/scripts/factory.mjs`, `core/scripts/lib/driver.mjs` (pure decision table), `core/scripts/lib/lock.mjs`
- Test: `tests/validation/factory-driver.test.mjs` (new)

**Interfaces:**
- Consumes: everything above; `deliver.mjs` as a subprocess with `DELIVER_QUEUE` set to `FACTORY_HOME/queues/<repo-key>.json` and `--dir <clone>`.
- Produces: `lock.mjs`: `acquire(repoKey) -> { release() }` (exclusive create; pid + process start time; stale only if that pid+start time is gone; records process groups); `factory run` refuses when held.
- Produces: `driver.mjs`: `nextAction(feature, lastResult) -> { do: 'next'|'build'|'built'|'pr'|'ci'|'fix_ci'|'verify'|'fix_verify'|'merge'|'block'|'hold'|'stop', reason? }` implementing the spec's Driver actions table row for row, plus `resumeAction(feature, facts)` for the Crash-and-resume rules.
- Produces: CLI `factory scenarios [--only IDS] [--approve ID --by NAME]` and `factory run [--only IDS] [--limit N]`:
  - `run` start: lock; clone or update `FACTORY_HOME/clones/<repo-key>` (`gitSafe`); read base policy from `refs/remotes/origin/<base>`; refuse unless `verification.required: true`, readiness level ≥ 4 (Phase 0 file and gate), and branch protection on base requires `factory/verified` (fake gh supports it); refuse features without current approved scenarios; then `deliver init` with merge from the committed `merge.mode`.
  - Loop: build sessions via `runSession({role:'builder'})` in the clone with briefs (build: id + spec path; CI fix: check names + bounded tail; symptom fix: Task 9 brief lines only); G-checks at built; `deliver built|pr|ci|fix|push|merge`; `verifyFeature` at `ci_passed`; `postVerified` on pass; usage-limit failure → stop the run leaving state (Phase 2 adds waiting).
  - `scenarios`: author session per ready feature with criteria from the base spec; lint; store; approve (`auto`) or wait (`human`).
  - Output to the terminal: states and counts only.
- Produces: run-record additions (Phase 0 `runrecord.mjs`, written by `deliver.mjs` from fields the driver sets on the queue feature): `verify_runs`, `verify_ms`, `verdict`, `verdict_sha`, `gap_criteria` (criterion IDs where CI passed but verification failed), `antigaming` (G ids that fired), `override_note` present (boolean only), and `sessions: [{ role, id, in, out, cache_create, cache_read, turns }]`. IDs and counts only.

- [ ] **Step 1: Failing tests** (`driver.mjs` unit tests cover every table row and every resume rule; integration tests with fake `claude` and fake `gh` cover): two API features delivered end to end with `factory/verified` posted on the merged sha; a wrong build → `verify_failed` → symptom-fix session receives only the brief (assert the fake claude's received prompt has no canary/path/data) → fixed → merged; builder `blocked` → feature blocked with an attention line; config-injection PR (`.claude/settings.json`) held by G4 (Review Focus 1); second `factory run` refused while locked; driver killed after `built` then restarted resumes without a second build session (Review Focus 4); missing protection → refusal with fix text; the merged feature's run record carries the verification fields and session usage, and contains no scenario text.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; full suite in the background.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): factory driver (run, scenarios, lock, resume)`

### Task 12: Benchmark (API, 1a)

**Files:**
- Create: `bench/factory/app/` (tiny task-list JSON API + spec files with AC/EC/ER and HTTP contract), `bench/factory/cases/` (one patch per case), `bench/factory/run.mjs`
- Test: `tests/validation/factory-bench.test.mjs` (structure only: every case applies cleanly; the good reference passes its own scenarios with the API engine; no real `claude` call)

**Interfaces:**
- Produces: `node bench/factory/run.mjs [--set tuning|heldout] [--twice]` — for each case: apply the patch on a scratch copy, run anti-gaming and API verification with stored scenarios, print per-category catch counts, false rejects, canary-leak scan of the builder-readable tree and PR text. Scenarios for the bench are authored once with `factory scenarios` (real author session, run by the user) and stored under `bench/factory/scenarios/` with their canary; the tuning/held-out split follows the spec table (API-relevant rows only: good 4/10, stub 2/6, wrong 2/6, edge 2/6, test-edit 1/3, snooping 1, listener 1, config-injection 1).

- [ ] **Step 1: Failing structure tests.** **Step 2:** FAIL. **Step 3:** Build the app, cases and runner. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(bench): phase 1a API benchmark fixture and runner`

### Task 13: Docs, validator, changelog

**Files:**
- Create: `references/verification.md`, `references/factory-driver.md`
- Modify: `SKILL.md` (short section + commands), `references/config.md`, `references/states.md`, `docs/guides/delivery-orchestrator.md`, `CHANGELOG.md`, `scripts/validate-skills.mjs` (required files: the new libs, `factory.mjs`, settings, prompts, references)

- [ ] **Step 1:** Write the references from the code (trust model, roles and settings, driver table, resume rules, verdicts, G-checks, known isolation gaps from the spike doc).
- [ ] **Step 2:** `npm run validate` — 0 errors; `npm test` in the background — all pass.
- [ ] **Step 3: Commit** `docs(delivery-orchestrator): verification and factory driver references`

### Task 14: Exit-criteria run (user)

- [ ] **Step 1:** Run the Phase 0 spike steps that 1a depends on (sandbox-deny steps 2–7 and 11; limit-detection step 2) and record results in the spike docs.
- [ ] **Step 2:** Author bench scenarios (`factory scenarios` on the bench repo), then `node bench/factory/run.mjs --set heldout`; record catch rates, false rejects, G-holds and canary scan in `docs/factory/spikes/phase-1a-trial.md`.
- [ ] **Step 3:** On a scratch GitHub repo with branch protection requiring `factory/verified`, confirm a `gh pr merge` from a builder-shaped shell is refused (exit criterion 6).
- [ ] **Step 4: Commit** `docs(factory): phase 1a exit-criteria trial results`
