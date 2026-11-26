# CLI Scenario Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the factory verify command-line features: a hidden `cli` scenario kind that checks exit code, stdout/stderr and files a command wrote, run by the existing verifier, plus an early `unverifiable` warning at authoring time.

**Architecture:** A new `clicheck.mjs` runs one `cli` scenario and shares text and `json_path` checks with `apicheck.mjs`. `verifyFeature` picks the runner by scenario kind and reuses its worktree, sandbox, twice-run, survivor, verdict and merge-gate machinery. The program under test is fixed by the reviewed base config (`app.cli`), and the spec's `## CLI contract` binds every scenario's arguments, as the HTTP contract binds API paths.

**Tech Stack:** Node >=22 ESM, zero dependencies, `node --test`, macOS `sandbox-exec` profiles, existing seams for fakes.

**Spec:** `docs/superpowers/specs/2026-11-27-cli-scenario-kind-design.md` (approved).

## Global Constraints

- Zero dependencies, Node >=22, ESM; every `skills/**` core file stays agent-neutral (`npm run validate` refuses host tokens such as the Claude config folder name).
- `parseConfig` stays the authority on config validity; new `app.cli` keys are typed and bounded (`command`: 1 to 10 strings; `timeout_s`: 1 to 120, default 30).
- No unsandboxed fallback for verification; `network: 'none'` (exists in `sandbox.mjs`) for the command under test.
- Verdict file keeps its 7 keys; terminal output stays states, IDs and counts only; the symptom brief never contains program output, args or expected values.
- A feature's scenarios are all `api` or all `cli`; a mix, or a spec with both contracts, is `unverifiable`.
- Existing behaviour is unchanged for `api` features: all current tests keep passing.
- Limits: `run.args` 0 to 64 strings of at most 4096 characters; `run.stdin` at most 64 KiB; `setup.files` at most 50 entries of at most 256 KiB; `setup.runs` at most 10; assertions at most 100; captured stdout/stderr at most 1 MiB each; file contents at most 1 MiB; file paths at most 256 characters.

## Review Focus

1. **`./` command element that escapes the worktree** (symlink or `..` after resolution): the config and runner refuse it. Pinned in Task 1 and Task 5.
2. **A file assertion through a symlink the command created** pointing outside the case folder: fails, never read. Pinned in Task 4.
3. **A command that writes into its own source tree:** the worktree is read-only during the run, so it fails honestly and is not masked. Pinned in Task 5.
4. **Output over 1 MiB, a hung command, or a command that leaves a background process:** `blocked` (never `pass`), with the survivor scan applied. Pinned in Task 4 and Task 5.
5. **A spec with no CLI contract but `cli` scenarios, or a pattern placeholder matching an empty argument:** lint refuses. Pinned in Task 3.

---

### Task 1: `app.cli` config key

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/config.mjs` (app parsing around the `app` block; defaults at the `app:` default)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/configschema.mjs` (schema entry, sensitive)
- Modify: `skills/delivery-orchestrator/references/config.md` (regenerated tables between the markers)
- Test: `tests/validation/cli-scenarios-config.test.mjs`

**Interfaces:**
- Produces: `parseConfig(raw).config.app.cli` is `null` or `{ command: string[], timeout_s: number }`. New export `cliCommandProblem(command: string[]): string | null` in `config.mjs` (null when acceptable), used again by Task 5.

- [ ] **Step 1: Write the failing tests** in `cli-scenarios-config.test.mjs`:
  - `app.cli` absent parses to `cli: null`.
  - `{ command: ['node','./src/cli.ts'] }` parses with `timeout_s: 30`.
  - Refused with a message naming `app.cli`: a string instead of a list, an empty list, 11 elements, an element that is not a string, `timeout_s` 0 or 121 or a float, unknown key inside `app.cli`.
  - `cliCommandProblem` refuses `['/usr/bin/node']` (absolute), `['node','../x']`, `['node','./a/../../x']`, an element with NUL or newline; accepts `['node','./src/cli.ts']` and `['pnpm','exec','seo']`.
  - The schema agreement test (`tests/validation/config-wizard-schema.test.mjs`) still passes, and `app.cli` is marked sensitive.
- [ ] **Step 2: Run** `node --test tests/validation/cli-scenarios-config.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the parser branch and `cliCommandProblem` in `config.mjs`; add `app.cli` to the default `app` object, the allowed `app` key list is derived from it. Add a schema entry in `configschema.mjs` of type `object-null` with `sensitive: true`, `readBy: ['factory run']`, and a `what`/`why` like the `app.start` entry. Regenerate the doc tables with the existing generator and commit the result.
- [ ] **Step 4: Run** the new test file, `tests/validation/config-wizard-schema.test.mjs` and `tests/validation/config-wizard-edit.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): app.cli config key for CLI verification`.

### Task 2: `## CLI contract` in the spec

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/criteria.mjs` (`extractCriteria`, `specRegions`)
- Modify: `skills/feature-intake/templates/feature-specification.md` (optional section, commented like the HTTP one)
- Modify: `skills/feature-intake/core/scripts/lib/spec.mjs` (accept the section; warn when both contracts exist)
- Test: `tests/validation/cli-scenarios-contract.test.mjs`

**Interfaces:**
- Produces: `extractCriteria(specText)` result gains `cliContract: Array<{ words: string[] }>` (each pattern's words after the first). New export `matchCliContract(cliContract, args: string[]): boolean` in `criteria.mjs`: a pattern word equals the argument, `<name>` matches exactly one non-empty argument, a final `...` allows any further arguments.
- The contract section is part of the canonical spec, so `criteriaHash` changes when it changes.

- [ ] **Step 1: Write the failing tests:**
  - A spec with a `## CLI contract` section listing `` `seo about` `` and `` `seo about --json` `` extracts two patterns with `words: ['about']` and `['about','--json']`.
  - A bullet without a backticked command, an empty section, or `{{` placeholder text yields an extraction error naming the CLI contract.
  - `matchCliContract` cases: exact match true; extra argument false; missing argument false; `<name>` matches `x` but not `''`; `...` allows zero or more trailing arguments; a pattern longer than the arguments false.
  - Changing one contract line changes `criteriaHash`.
  - `feature-intake` `check` on a spec with both an HTTP and a CLI contract passes but prints a warning containing `both an HTTP contract and a CLI contract`.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** the section as a visible region like `contract`, parse bullets with the same backtick rule, and export `matchCliContract`. Add the optional section to the template and to `feature-intake`'s section list and mixed-contract warning.
- [ ] **Step 4: Run** the new test plus `tests/validation/feature-intake-*.test.mjs` and the existing criteria tests (`factory-scenarios.test.mjs`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): CLI contract section in the spec`.

### Task 3: Lint for `cli` scenarios

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/scenarios.mjs` (`validAssertion` neighbours, `lintScenarios`)
- Test: `tests/validation/cli-scenarios-lint.test.mjs`

**Interfaces:**
- Consumes: `matchCliContract` and `extractCriteria(...).cliContract` from Task 2.
- Produces: `lintScenarios(doc, criteria, currentHash)` accepts `kind: 'cli'`. New exports `validCliAssertion(a): boolean`, `validRelPath(p): boolean` (relative, forward slashes, no `..` segment, no leading `/`, no NUL, at most 256 characters) and `CLI_LIMITS` (the limits from Global Constraints).

- [ ] **Step 1: Write the failing tests**, with the spec contract `seo about` and `seo about --json`:
  - A valid `cli` scenario (shape in the design) lints clean and the canary may live in `run.args`, `setup.files[].text`, an assertion value or `stdin`.
  - Refused, each with the scenario label in the problem: no `run`; empty `assert`; no `{exit}` assertion; `exit` of 256 or `-1`; `run.args` not matching the contract (`['init']`); a spec with no CLI contract; an empty placeholder argument; `args` with 65 entries or an entry of 4097 characters or containing NUL; `stdin` over 64 KiB; `setup.files` path `../x`, `/etc/passwd`, `a\\b`; 51 setup files; setup run args not matching the contract; 11 setup runs; 101 assertions; an unknown assertion shape; a `file` assertion with a bad path; an empty `contains`/`matches`; a `stdout` assertion with both `equals` and `json_path`.
  - A mix of an `api` and a `cli` scenario is refused with a message containing `mixes kinds`.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** `validCliAssertion`, `validRelPath`, `CLI_LIMITS` and the `cli` branch in `lintScenarios`; reuse `JSON_PATH_OPS` and the existing `matches` and empty-string rules. The canary scan walks `run`, `setup` and `assert` strings.
- [ ] **Step 4: Run** the new test and `tests/validation/factory-scenarios.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): lint for cli scenarios`.

### Task 4: `clicheck.mjs` runner and captured process runner

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/clicheck.mjs`
- Modify: `skills/delivery-orchestrator/core/scripts/lib/apicheck.mjs` (export the shared text and `json_path` evaluation: `textCheck(value, check, { regexTimeoutMs })`)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/proc.mjs` (`runCapture`)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/sandbox.mjs` (`runSandboxedCapture`)
- Test: `tests/validation/cli-scenarios-check.test.mjs`

**Interfaces:**
- `runCapture(argv, { cwd, env, timeoutS, stdin = '', maxBytes = 1048576 }): Promise<{ code: number|null, signal, timedOut: boolean, overflow: boolean, stdout: string, stderr: string }>`: same process-group, `detached`, kill-on-exit and `track` handling as `runCmd`; stdin is written then closed; each stream is capped at `maxBytes` and sets `overflow`.
- `runSandboxedCapture(argv, { cwd, env, timeoutS, profile, tmpDir, stdin, sandbox })`: `runSandboxed` shape, using `runCapture`.
- `runCliScenario(scenario, ctx) -> Promise<{ status: 'pass'|'fail'|'blocked', failed?: string }>` where `ctx = { command: string[], timeoutS: number, caseDir: string, run: (argv, { stdin }) => Promise<CaptureResult> }` (the verifier supplies `run`, so this module never spawns). `failed` is one of `exit`, `stdout`, `stderr`, `file`, `setup`, `run`.
- `textCheck(text: string, check: object): boolean` in `apicheck.mjs`.

- [ ] **Step 1: Write the failing tests** with a fake `run` that returns canned results and a real temp `caseDir`:
  - Pass: exit 0, `stdout` equals, `stdout` `json_path` equals on JSON output, `stderr` equals `''`, `file` exists, `file` `json_path` count on a file the fake run wrote.
  - Fail: wrong exit code; stdout mismatch; `json_path` on non-JSON stdout fails (not blocked); `file` `exists: false` on an existing file.
  - Blocked: `run` reports `timedOut`; `overflow`; non-zero exit of a `setup.runs` entry (`failed: 'setup'`); a setup file write failure.
  - Order: `setup.files` are written before `setup.runs`, and runs execute in order with their own stdin.
  - **File safety:** an assertion path whose realpath leaves `caseDir` through a symlink fails with `failed: 'file'` and the target is never read (check the target's contents are not in any result); a path to a directory fails; a file over 1 MiB fails.
  - `runCapture` (real process, no sandbox): separate stdout and stderr, stdin delivered, exit code, 100 ms timeout kills a sleeping child and sets `timedOut`, output beyond `maxBytes` sets `overflow`, a backgrounded child is killed with the group.
  - `textCheck` keeps every `apicheck` behaviour (equals, contains, not_contains, matches with the 500 ms worker, `json_path` ops); existing `apicheck` tests pass unchanged.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** the four exports. `runCliScenario` writes `setup.files` (mode 0600, parents created, inside `caseDir` by realpath check), runs `setup.runs`, runs the command with `command` + `run.args` and `run.stdin`, then evaluates assertions through `textCheck`; any `blocked` condition short-circuits.
- [ ] **Step 4: Run** the new test, `tests/validation/factory-verify.test.mjs` and the existing `apicheck` tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): cli scenario runner and captured process runner`.

### Task 5: Verifier integration

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/verify.mjs` (`apiScenarios` -> kind dispatch, `appPlan`, `verifyFeature`, `symptomBrief`)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/sandbox.mjs` (read-only worktree profile option if `writable` cannot express it)
- Test: `tests/validation/cli-scenarios-verify.test.mjs`

**Interfaces:**
- Consumes: `runCliScenario`, `runSandboxedCapture`, `cliCommandProblem`, `parseConfig` `app.cli`.
- Produces: `scenarioPlan(doc, criteriaHash) -> { kind: 'api'|'cli', list }` (throws for ui, mixed, unknown, empty, over the limit) replacing `apiScenarios` internally; `verifyFeature` accepts `config.app.cli` for `cli` sets. New export `verifiable(doc, config): { ok: true } | { ok: false, why: string }` where `why` is one of `ui scenarios`, `mixed kinds`, `needs app.cli`, `needs app.start`, `no scenarios`, used by Task 6.

- [ ] **Step 1: Write the failing tests** with the existing fake-sandbox seams (`seams.runSandboxed...`; follow `factory-verify.test.mjs`):
  - A `cli` set with `app.cli` set and no `app.start`, `base_url` or `ready` verifies: no port check, no `app.stop`, two runs per scenario in two different case folders, verdict `pass`, verdict file keys unchanged.
  - The worktree is mounted read-only in the run phase and the case folder and run temp are the writable paths; the command runs with `cwd` the case folder, `HOME` and `TMPDIR` inside the run temp, `CI=1`, `NO_COLOR=1`, network `none`, and the first command element `./x` resolved to the worktree.
  - A `./` element resolving outside the worktree (symlink or `..`) throws before any phase.
  - A command that writes into the worktree fails its scenario (read-only).
  - Two runs disagreeing gives `fail` with `flaky: true`; a hung command or an overflow gives `blocked`; a surviving background process throws escaped and no verdict is left.
  - Refusals: mixed kinds, a `cli` set without `app.cli`, an `api` set without `app.start`, ui still refused.
  - `symptomBrief` for a failing `cli` scenario contains the criterion IDs and the failed family word (`exit`, `stdout`, `stderr` or `file`) and none of the scenario's args, expected values or program output.
  - All existing `factory-verify.test.mjs` tests still pass.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** `scenarioPlan`, `verifiable`, a `cliPlan(config)` beside `appPlan`, the `cli` run branch in `verifyFeature` (fresh case folder per run under the run temp, setup phase unchanged, skip the port checks and `stopRunning` for `cli`), and the `symptomBrief` family word. Keep the survivor scan and final sweep as they are.
- [ ] **Step 4: Run** the new test and `tests/validation/factory-verify.test.mjs`, `factory-driver.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): verify cli scenarios in the existing verifier`.

### Task 6: Early warning and the author prompt

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/factory.mjs` (`cmdScenarios` outcome and summary line, `factory run` start refusal)
- Modify: `skills/delivery-orchestrator/core/prompts/scenario-author.md` (the `cli` shape and the kind choice)
- Test: `tests/validation/cli-scenarios-driver.test.mjs`

**Interfaces:**
- Consumes: `verifiable(doc, config)` from Task 5, `lintScenarios` from Task 3.
- Produces: `factory scenarios` prints `<ID> scenarios: stored (<n>), approved: auto, unverifiable (<why>)` and the summary counts gain `unverifiable N`; `factory run` refuses with `refused: <ID> has scenarios the verifier cannot run (<why>)` and a `fix:` line, exit 1, before any session. `--only` still selects features.

- [ ] **Step 1: Write the failing tests** using `factory-world.mjs`:
  - A spec with a CLI contract and a fake author reply of `cli` scenarios: stored, no `unverifiable`, with `app.cli` set.
  - The same without `app.cli` in the config: stored with `unverifiable (needs app.cli)`.
  - A fake author reply with `ui` scenarios: stored, `unverifiable (ui scenarios)`; `factory run` refuses before any session and `--only` another feature runs.
  - A spec with both contracts: `unverifiable (mixed kinds)`.
  - The author prompt text contains the `cli` scenario shape and tells the author to use `cli` when the spec has a CLI contract and no HTTP contract (assert on the rendered prompt in the fake session's argv).
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** the outcome line and refusal in `factory.mjs`, and extend the prompt with the `cli` shape (keep it parallel to the API section; never name `ui` as a choice when a contract exists).
- [ ] **Step 4: Run** the new test, `tests/validation/factory-driver.test.mjs` and `tests/validation/factory-scenarios.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): flag unverifiable scenarios when authoring and before a run`.

### Task 7: Readiness C9, docs and the bench

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/readiness.mjs` (`CHECKS`, `computeLevel`, `HELP`, the C9 runner in `runChecks`)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/factorycheck.mjs` (accept `app.cli` in place of a startable app)
- Modify: `skills/delivery-orchestrator/references/verification.md`, `references/readiness.md`, `references/factory-driver.md`, `references/config.md` (generated parts), `docs/guides/delivery-orchestrator.md`, `CHANGELOG.md`
- Test: `tests/validation/cli-scenarios-readiness.test.mjs`

**Interfaces:**
- `CHECKS` gains `{ id: 'C9', level: 4, runsCommands: true }`. `computeLevel` rule: C6, C7 and C8 may be `skip` when `app.cli` is set and `app.start` is not, if C9 passes; otherwise a skip is a non-pass as today. `computeLevel(results, { cliOnly })` gains an options argument, default `{ cliOnly: false }`.
- C9 runs `app.setup` then `app.cli.command` with no arguments in an empty case folder, in a temp worktree of the base tip, unsandboxed like C6 to C8 (`proc.runCmd`/`runCapture`), allowlisted environment, no stdin; `pass` when the process exits within `timeout_s` with any exit code and no survivor remains; `fail` on timeout or spawn error; `skip` when `app.cli` is null.

- [ ] **Step 1: Write the failing tests:**
  - `computeLevel` with C1 to C5 and C9 passing and C6 to C8 skipped gives level 4 only with `{ cliOnly: true }`; level 3 otherwise; C9 failing gives level 3.
  - With both `app.start` and `app.cli` set, C6 to C9 must all pass.
  - C9 against a temp repo whose `app.cli.command` is `['node','-e','process.exit(2)']` passes; one that sleeps past `timeout_s` fails; a missing binary fails; `app.cli` null skips.
  - `fixItem('C9', ...)` returns a help line naming `app.cli`.
  - `factorycheck` accepts a config with `app.cli` and no `app.start` for the `factory run` readiness requirement.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** C9, the `computeLevel` option and the `factorycheck` change; update the docs: a `cli` kind section and a worked example in `verification.md` (shape, limits, contract, case folder, read-only worktree, refusals), `readiness.md` C9, `factory-driver.md` known gaps (C9 runs unsandboxed; mixed kinds; no UI), the guide, and a CHANGELOG entry. Regenerate the config tables.
- [ ] **Step 4: Run** `npm run check` from the repository root. Expected: validate 0 errors and the full suite passes.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): readiness C9, docs and changelog for cli scenarios`.
- [ ] **Step 6: Bench acceptance** (not part of the suite). On `/Users/sourav/.factory-bench` (scratch repo `sourav-ojha/seo-bench-scratch`, clean home `/Users/sourav/.factory-bench/home`): through the usual PR merge (protection pause as before), add `app.cli` (`["node","./node_modules/tsx/dist/cli.mjs","./src/cli.ts"]`) and a `## CLI contract` to FEATURE-008 via `fi reopen`/edit/`approve` with the user's words; delete the stale scenarios; run `factory scenarios` and `factory run` from `run.sh`. Expected: FEATURE-008 verified and merged. Record the outcome and any new gap in `docs/factory/roadmap.md`.

---

## Self-Review

- **Spec coverage:** config key (T1); CLI contract and canonical hash (T2); lint and limits, contract binding, mixed kinds (T3); runner, text/`json_path`/file checks, symlink safety, capture and stdin, no network (T4); verifier reuse, case folder, read-only worktree, twice-run, survivor checks, refusals, symptom brief (T5); `unverifiable` outcome, early refusal, author prompt and both-contract case (T6); readiness C9, `computeLevel`, docs, bench acceptance (T7). Anti-goals: fixed program (T1, T5), no outside file reads (T4), unchanged verdict machinery (T5), hidden scenarios (T5 brief).
- **Type consistency:** `cliContract` and `matchCliContract` (T2) are used in T3; `validCliAssertion`, `validRelPath`, `CLI_LIMITS` (T3) in T4 and T5; `runCliScenario`'s `ctx.run` is supplied by `runSandboxedCapture` in T5; `verifiable` (T5) is used in T6; `computeLevel(results, { cliOnly })` (T7) is the only signature change.
- **Proportion:** seven tasks; code appears only for interfaces.
