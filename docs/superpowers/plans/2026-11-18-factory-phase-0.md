# Factory Phase 0 (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A readiness check with levels 0–4 that gates merging for repos that opt in, per-feature run records joinable to transcript tokens, and two spikes (usage-limit detection, sandbox deny proof) whose answers later phases depend on.

**Architecture:** Everything lands in the `delivery-orchestrator` skill as zero-dependency Node ESM: new pure libs (`readiness.mjs`, `proc.mjs`, `runrecord.mjs`, `limits.mjs`), a `deliver readiness` command and an `init` gate in `deliver.mjs`, and a `runs-factory` command in `skill-insights`. Factory-private state lives under `FACTORY_HOME` (default `~/.factory`, overridable for tests).

**Tech Stack:** Node.js 20+ ESM, `node:test`, real git with a bare origin, the fake `gh` in `tests/validation/fixtures-gh/gh.mjs`.

**Spec:** [docs/factory/specs/phase-0-foundations.md](../../factory/specs/phase-0-foundations.md)

## Global Constraints

- Zero runtime dependencies; Node 20+; ESM.
- Every external command runs as an argument list via `spawnSync`/`spawn` without a shell.
- Config parsing stays strict: unknown keys and wrong types are errors.
- `skills/*/core/scripts/lib/runlog.mjs` stays byte-identical across skills (a test enforces it); `runrecord.mjs` copies its no-follow append, it does not import it.
- `skills/delivery-orchestrator/SKILL.md` stays under 500 lines; detail goes to `references/readiness.md`.
- `FACTORY_HOME` = `process.env.FACTORY_HOME || path.join(os.homedir(), '.factory')`; tests always set it to a temp dir.
- `repo-key` = `nameWithOwner` with `/` replaced by `__` (e.g. `sourav-ojha__agent-skills`).
- Existing tests must pass unchanged. Delivery tests take about 2 minutes: run `npm test` in the background.
- Readiness commands get only: `PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_ENV=test`, `CI=1`, plus `env_example` pairs.

## Review Focus

1. **Port already in use before C6** (your dev server is running): C6 must `fail` with reason `port in use`, never pass against the existing server. Test in Task 3.
2. **App that leaves a detached child holding the port after stop**: C6 must `fail` with reason naming the port. Test in Task 3.
3. **Shell metacharacters in configured commands** (`["sh","-c","echo hi; touch /tmp/x"]` is fine as argv, but `["echo","$(touch x)"]` must not expand): no file created. Test in Task 2.
4. **Readiness file for a different config** (edited `.product/delivery.json` after the check): `init` must refuse with "config changed since readiness check". Test in Task 5.
5. **Secrets in command output tails** (a test printing `AWS_SECRET_ACCESS_KEY=...` or a GitHub token): fix items contain the redacted form only. Test in Task 3.

---

### Task 1: Config keys `app`, `tests`, `readiness`

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/lib/config.mjs` (`defaults()`, `parseConfig()` allowed keys)
- Modify: `skills/delivery-orchestrator/templates/delivery.json`, `skills/delivery-orchestrator/references/config.md`
- Test: `tests/validation/factory-readiness.test.mjs` (new)

**Interfaces:**
- Produces: `defaults().app = { setup: null, start: null, stop: null, base_url: null, ready: null, logs_dir: null, seed: null, env_example: null }`, `defaults().tests = { setup: null, all: null, timeout_s: 900 }`, `defaults().readiness = null` (null means "not opted in"); when present, `{ min_level: 3, max_age_days: 14 }` with given values merged.
- Produces: `isLocalUrl(u: string) -> boolean` exported from `config.mjs` (true only for `http://localhost:<port>` or `http://127.0.0.1:<port>`).

- [ ] **Step 1: Write failing tests**

```js
test('config: app/tests/readiness parse with defaults', () => {
  const { config, errors } = c.parseConfig({ app: { start: ['npm','run','dev'], ready: { url: 'http://localhost:3000/health', timeout_s: 120 } }, tests: { all: ['npm','test'] }, readiness: { min_level: 4 } });
  assert.deepEqual(errors, []);
  assert.equal(config.readiness.min_level, 4); assert.equal(config.readiness.max_age_days, 14);
  assert.equal(config.tests.timeout_s, 900);
});
test('config: readiness absent means not opted in', () => assert.equal(c.parseConfig({}).config.readiness, null));
test('config: rejects non-local ready url, shell strings, unknown keys, bad bounds', () => {
  for (const raw of [
    { app: { ready: { url: 'http://example.com:80/' } } },
    { app: { start: 'npm run dev' } },
    { app: { foo: 1 } },
    { app: { ready: { url: 'http://localhost:3000', log_pattern: 'x' } } },  // exactly one of url / log_pattern
    { readiness: { min_level: 5 } }, { readiness: { max_age_days: 0 } },
    { tests: { timeout_s: 4000 } },
  ]) assert.ok(c.parseConfig(raw).errors.length, JSON.stringify(raw));
});
```

- [ ] **Step 2: Run `node --test tests/validation/factory-readiness.test.mjs`** — expect FAIL (unknown key `app`).

- [ ] **Step 3: Implement** in `config.mjs`: add `app`, `tests`, `readiness` to the allowed top-level keys; validate commands with the existing `strList` (max 30 args); `ready` is an object with exactly one of `url` (must satisfy `isLocalUrl`) or `log_pattern` (string ≤ 200, must compile as `RegExp`) plus `timeout_s` (1–600, default 120); `base_url` must satisfy `isLocalUrl`; `logs_dir`, `env_example` are relative in-repo paths (same rule as `features_dir`); `readiness.min_level` integer 1–4; `max_age_days` integer 1–90; `tests.timeout_s` integer 1–3600. Add the keys to the template and a table section in `references/config.md`.

- [ ] **Step 4: Run the test file** — expect PASS. Run `node --test tests/validation/delivery-orchestrator.test.mjs` in the background — expect PASS (unchanged).

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): readiness config keys (app, tests, readiness)`

### Task 2: Process runner with allowlisted environment

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/proc.mjs`
- Create fixtures: `tests/fixtures/factory-apps/{ready,never,stubborn,nolog,flaky,detached}.mjs`
- Test: `tests/validation/factory-proc.test.mjs`

**Interfaces:**
- Produces: `allowEnv(envExampleText: string|null, base = process.env) -> Record<string,string>` (only the allowlisted keys plus parsed `KEY=VALUE` lines; comments and blank lines ignored).
- Produces: `runCmd(argv: string[], { cwd, env, timeoutS }) -> { code: number|null, timedOut: boolean, ms: number, tail: string }` (`tail` = last 40 lines of stdout+stderr, redacted).
- Produces: `startApp(argv, { cwd, env }) -> { pid, pgid, output(): string }` (spawned `detached: true` so it leads its own process group).
- Produces: `stopApp(app, { stopArgv?, cwd, env, graceMs = 10000 }) -> Promise<void>` (stop command if given, else SIGTERM to `-pgid`, SIGKILL after `graceMs`).
- Produces: `waitReady(ready: {url?, log_pattern?, timeout_s}, app) -> Promise<boolean>`.
- Produces: `portOf(url: string) -> number`, `portInUse(port: number) -> Promise<boolean>` (TCP connect to 127.0.0.1).
- Produces: `redact(text: string) -> string` — reuse the patterns of `skill-insights/core/scripts/lib/runs.mjs` `redactText` by copying them (no cross-skill import).

Fixture apps (each a tiny `node:http` server on `process.env.PORT`): `ready` (serves `/health` 200, writes `logs/app.log`), `never` (listens but `/health` 503), `stubborn` (ignores SIGTERM), `nolog` (ready, writes no log), `flaky` (ready only when a counter file is odd; increments it on each start), `detached` (spawns a `detached`+`unref` child that keeps the port, then exits).

- [ ] **Step 1: Write failing tests**: `allowEnv` drops `GH_TOKEN`/`AWS_SECRET_ACCESS_KEY` from base and keeps `PATH`; `runCmd(['node','-e','console.log(process.env.GH_TOKEN||"none")'], {env: allowEnv(null, {...process.env, GH_TOKEN:'x'})})` tail is `none`; `runCmd(['echo','$(touch pwned)'])` creates no `pwned` file (Review Focus 3); timeout returns `timedOut: true`; `startApp` + `waitReady` on `ready` returns true and `stopApp` frees the port; `stubborn` is killed within 11 s; `redact('token ghp_' + 'a'.repeat(36))` does not contain the token (Review Focus 5).

- [ ] **Step 2: Run** `node --test tests/validation/factory-proc.test.mjs` — expect FAIL (module missing).

- [ ] **Step 3: Implement `proc.mjs`** per the Interfaces; `waitReady` polls the URL every 500 ms (or scans `output()` for the pattern) until `timeout_s`.

- [ ] **Step 4: Run the test file** — expect PASS.

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): process runner with allowlisted env and process-group stop`

### Task 3: Readiness checks and levels

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/readiness.mjs`
- Modify: `tests/validation/fixtures-gh/gh.mjs` (protection and rules endpoints)
- Test: `tests/validation/factory-readiness.test.mjs`

**Interfaces:**
- Consumes: Task 1 config, Task 2 `proc.mjs`.
- Produces: `CHECKS` (array of `{ id: 'C1'..'C8'|'A1', level: 0..4, runsCommands: boolean }`; A1 has level 0 = advisory).
- Produces: `computeLevel(results: Array<{id, status}>) -> number` (highest L with every check at levels 1..L `pass`).
- Produces: `fixItem(id: string, result) -> { id, what, change, help }` (static help text per check, no inferred values).
- Produces: `runChecks(ctx, { only?: string[] }) -> Promise<Array<{ id, status: 'pass'|'fail'|'skip'|'unstable', reason, ms }>>` where `ctx = { root, config, base, git(...a), gh(...a), worktree(sha) -> { dir, remove() } }`. Command checks C3, C6–C8 run in `ctx.worktree(baseSha)`; a failing command check is retried once; fail→pass is `unstable`.
- Produces: `SECRET_PATTERNS` used by C4: `.env`, `.env.*` except `config.app.env_example`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`.

Check semantics are exactly the spec's table (C1–C8, A1). C5 uses `CI_PATHS` from `queue.mjs` excluding the `CODEOWNERS` pattern. A1 queries `repos/{o}/{r}/branches/{b}/protection` and `repos/{o}/{r}/rules/branches/{b}`; 404 on both → `fail`, other errors → `unknown`.

Fake `gh`: add `api repos/<o>/<r>/branches/<b>/protection` and `api repos/<o>/<r>/rules/branches/<b>` returning `st.protection` / `st.rules` JSON or exiting 1 with `HTTP 404` when absent.

- [ ] **Step 1: Write failing tests**:
  - `computeLevel` table: all pass → 4; C3 fail → 1; C1 skip → 0; C6 unstable → 3.
  - C1 fails when the config file is missing; C4 fails on a tracked `.env`, passes when only `.env.example` (configured) is tracked; C4 fails when `logs_dir` is not ignored.
  - C5 fails with only `CODEOWNERS`; passes with `.github/workflows/ci.yml` and `checks.required: ['test']`.
  - C6 with fixture `ready` → pass; `never` → fail; port pre-occupied by a test server → fail with reason containing `port in use` (Review Focus 1); `detached` → fail with reason containing the port (Review Focus 2). C7 fails with `nolog`. C6 with `flaky` → `unstable`.
  - C3 with a test command that prints a fake token and exits 1 → fix item `help` exists and `tail` is redacted (Review Focus 5).
  - A1: protection 404 + rules 404 → `fail`; protection JSON with required checks → `pass`.

- [ ] **Step 2: Run** the test file — expect FAIL.

- [ ] **Step 3: Implement `readiness.mjs`** per Interfaces. Worktree: `git worktree add --detach <tmp> <sha>`, removed with `git worktree remove --force` in `finally`.

- [ ] **Step 4: Run** the test file — expect PASS.

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): readiness checks C1-C8, advisory A1, levels`

### Task 4: `deliver readiness` command and stored result

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/deliver.mjs` (new command, HELP text, `BOOL`)
- Create: `skills/delivery-orchestrator/core/scripts/lib/factoryhome.mjs`
- Test: `tests/validation/factory-readiness.test.mjs`

**Interfaces:**
- Produces: `factoryHome() -> string`, `repoKey(nameWithOwner: string) -> string`, `writeJsonAtomic(file, obj)` (write to `file.tmp-<pid>`, then rename; refuses if the target or its directory is a symlink), `readJson(file) -> object|null` in `factoryhome.mjs`.
- Produces: readiness file `FACTORY_HOME/readiness/<repo-key>.json` = `{ helper_version, base_sha, config_hash, level, results, fixes, at }` where `config_hash = 'sha256:' + sha256(raw config file bytes on origin/<base>)`.
- Produces: CLI `deliver readiness [--repeat 2] [--json]`: prints a summary (level, one line per check, fix count); exit 0 when level ≥ `readiness.min_level` (or ≥ 1 when not opted in), else 2.

- [ ] **Step 1: Write failing tests**: a ready fixture repo (config with `app` using fixture `ready`, `tests.all` = `['node','-e','process.exit(0)']`, CI file, `checks.required`) gives level 4 and writes the file under the temp `FACTORY_HOME`; `--repeat 2` produces identical `results` statuses; the file contains no environment values (assert `GH_TOKEN` value from the test env is absent).

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** the command: resolve repo via the existing `gh repo view` path, fetch `origin`, compute base sha, run `runChecks`, compute level and fixes, write the file, print.

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): deliver readiness command`

### Task 5: Gate in `deliver init`

**Files:**
- Modify: `skills/delivery-orchestrator/core/scripts/deliver.mjs` (`init`)
- Modify: `skills/delivery-orchestrator/core/scripts/lib/queue.mjs` only if the queue schema needs `readiness_level` (add the field to the object `init` builds, not to `TRANSITIONS`)
- Test: `tests/validation/factory-readiness.test.mjs`

**Interfaces:**
- Consumes: Task 3 `runChecks(ctx, { only: ['C1','C2','C4','C5'] })`, `computeLevel`; Task 4 file format.
- Produces: queue field `readiness_level: number|null`.

Gate applies only when `q.merge` is true (after `--merge`, `merge.mode` and protected-base handling) **and** `config.readiness !== null`. Then: refuse (exit 1, message + fix list) if the file is missing, older than `max_age_days`, `config_hash` differs, or `min(stored level, level from re-run cheap checks capped at the stored level)` is below `min_level`. When the gate doesn't apply and a readiness file exists with level < 3, add a `warnings` entry.

- [ ] **Step 1: Write failing tests**: existing `init` tests untouched still pass; with `readiness` + merge and no file → refused with "run deliver readiness"; stale file (set `at` 15 days back) → refused; config edited after the check → refused with "config changed since readiness check" (Review Focus 4); stored level 4 but a tracked `.env` added afterwards → refused (cheap re-run lowers it); `merge.mode: pr-only` with `readiness` → not gated; passes and stores `readiness_level` otherwise.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** the gate in `init` after the existing config checks and before the queue is written.

- [ ] **Step 4: Run** this file, then the full delivery test file in the background — expect PASS.

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): readiness gate for merging runs`

### Task 6: Run records

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/runrecord.mjs`
- Modify: `skills/delivery-orchestrator/core/scripts/deliver.mjs` (write points; CI counters in `ci`)
- Test: `tests/validation/factory-runrecord.test.mjs`

**Interfaces:**
- Produces: `projectHash(absPath: string) -> string` = `sha1(absPath.replace(/[^A-Za-z0-9]/g, '-')).slice(0, 6)`.
- Produces: `skillStamp(skillDir: string) -> { version: string|null, sha: string }` (`metadata.version` from `SKILL.md` frontmatter; `sha` = first 12 hex of sha256 of the file).
- Produces: `appendRecord(root: string, rec: object)` → appends one JSON line to `<root>/.skill-runs/factory-runs.jsonl` using a copied no-follow append, creating `.skill-runs/.gitignore` with `*` if missing; never throws.
- Produces: `latestPerFeature(lines: object[]) -> object[]` (last record per `run`+`feature`).
- Produces: queue fields per feature: `ts_start` (set on first `next`), `ci_runs` (incremented each `ci` call), `ci_wait_ms` (added each `ci` call, including success).

Record fields are exactly the spec's P0.2 table, with `kind: 'factory-run'` and no `event` key. Write points: after the transition in `next` (dependency skips from `pickNext`), `merge` and `merged()`, `block()`, `stopRun()`, and merges discovered by `refresh()`.

- [ ] **Step 1: Write failing tests**: `projectHash('/Users/a/b')` equals the hash skill-insights computes for transcript folder `-Users-a-b`; a full pipeline test run (reuse the existing `ship` helper pattern) produces one `merged` record per feature; a CI-failure-then-fix feature records `ci_runs: 2` and `fix_rounds: 1`; a blocked feature and a dependency-skipped feature each produce a record; `awaiting_human` then `merged` produces two records and `latestPerFeature` keeps the merged one; records contain no `event` key and `si export` does not ingest them (run `si.mjs export` on the dir and assert zero events from `factory-runs`); `.skill-runs` as a symlink → nothing written.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** `runrecord.mjs` and the write points.

- [ ] **Step 4: Run** this file and the delivery tests in the background — expect PASS.

- [ ] **Step 5: Commit** `feat(delivery-orchestrator): per-feature run records`

### Task 7: `skill-insights runs-factory` token join

**Files:**
- Modify: `skills/skill-insights/core/scripts/si.mjs` (new command; help text)
- Modify: `skills/skill-insights/core/scripts/lib/transcripts.mjs` (include subagent transcripts)
- Create: `skills/skill-insights/core/scripts/lib/factory.mjs`
- Modify: `skills/skill-insights/references/metrics.md`
- Test: `tests/validation/skill-insights.test.mjs` (extend) with fixture transcripts

**Interfaces:**
- Consumes: Task 6 record format.
- Produces: `joinTokens(records: object[], turns: Array<{ project, ts, tokens: {in,out,cache_create,cache_read} }>) -> Array<record & { tokens_in, tokens_out, cache_create, cache_read, turns, status: 'ok'|'ambiguous' }>` in `lib/factory.mjs` (pure).
- Produces: CLI `si.mjs runs-factory [--dir D] [--out FILE]` (reads `<D>/.skill-runs/factory-runs.jsonl`, latest per feature; prints a table; writes the enriched copy only with `--out`).

First step of the task: locate where Claude Code stores subagent transcripts by inspecting `~/.claude/projects/<project>/` on this machine (subdirectories or sibling files); record the layout in `references/metrics.md`; extend the loader to read them, tagged with the parent project hash.

- [ ] **Step 1: Write failing tests**: two non-overlapping records over fixture turns sum correctly; a turn inside both windows → both records `ambiguous`; subagent fixture turns are counted; coverage helper reports ≥ 90% attribution for a fixture where 95% of turns fall in windows.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** `joinTokens`, the loader change and the command (register `runs-factory` as a command name, not a `--` flag).

- [ ] **Step 4: Run** `node --test tests/validation/skill-insights.test.mjs` — expect PASS.

- [ ] **Step 5: Commit** `feat(skill-insights): runs-factory joins transcript tokens to factory run records`

### Task 8: Spike P0.3 — usage-limit detection and classifier

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/limits.mjs`
- Create: `skills/delivery-orchestrator/core/scripts/capture.mjs` (hook and wrapper entry point)
- Create: `tests/fixtures/limits/*.json` (documented shapes now; real captures later)
- Create: `docs/factory/spikes/limit-detection.md`
- Test: `tests/validation/factory-limits.test.mjs`

**Interfaces:**
- Produces: `classifyFailure(payload: object|string) -> { kind: 'session'|'weekly'|'model'|'rate'|'other', resetAt: string|null, source: 'event'|'text'|'status'|'none' }` (pure).
- Produces: `capture.mjs hook` (reads a `StopFailure` hook payload on stdin) and `capture.mjs wrap -- <claude args…>` (runs `claude -p` and, on `is_error`, saves the JSON); both write redacted payloads to `FACTORY_HOME/captures/<timestamp>.json`.

Rules: `is_error: true` is required for any non-`other` kind; `rate_limit_event.rateLimitType` → kind (`five_hour` → `session`, `seven_day*` → `weekly`, model names → `model`); otherwise the result text: "session limit" → `session`, "weekly limit" → `weekly`, "Opus limit"/"Sonnet limit" → `model`, "Rate limit reached" or `api_error_status: 429` without those → `rate`; reset from an epoch field, else from "resets 3:45pm" / "resets Mon 12:00am" in local time.

- [ ] **Step 1: Write fixture-based failing tests** for each kind, a success payload (`other`, no reset), an `is_error` with unrelated text (`other`), and reset parsing for both text forms with a fixed `TZ`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `limits.mjs` and `capture.mjs`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Answer the spec's nine questions** against the installed Claude Code (`claude --version` recorded): run `claude -p "say hi" --output-format json` and with `stream-json` (with and without `--verbose`) to record session id and usage fields; try invoking a skill under `-p`; check `--help` and settings docs for auto-continue and `CLAUDE_CODE_RETRY_WATCHDOG`; install the capture hook and wrapper for passive capture. Write `docs/factory/spikes/limit-detection.md` with answers, evidence, unknowns, and whether the classifier is "verified" or "fixtures only". Timebox: half a day.
- [ ] **Step 6: Commit** `feat(delivery-orchestrator): usage-limit classifier and capture tooling; spike notes`

### Task 9: Spike P0.4 — sandbox deny probe

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/probe.mjs`
- Create: `docs/factory/spikes/sandbox-deny.md`
- Test: `tests/validation/factory-probe.test.mjs` (probe logic only, against a temp "denied" dir it can read → reports `leaked`)

**Interfaces:**
- Produces: `probe.mjs --target <dir> --write-target <dir> [--json]` → `{ routes: Array<{ route, result: 'denied'|'leaked'|'error', detail }> }`; routes: `fs.readFile`, `cat`, `cp`, `find`, `tar`, `mdfind`, `qlmanage`, `python -c`, `git -C`, hard link, symlink in cwd, write to `--write-target`. Tool-level routes (Read, Grep, Glob, WebFetch `file://`, subagents, MCP) are listed in the doc as a manual checklist run from inside a builder session.

- [ ] **Step 1: Write failing test**: unsandboxed, every shell route reports `leaked` for a readable temp dir.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement** `probe.mjs`. **Step 4: Run** — expect PASS.
- [ ] **Step 5: Run the spike**: for each candidate configuration in spec order (Claude Code deny rules plus sandbox; separate macOS user; container), run `probe.mjs` from a builder session and the manual tool checklist; answer the spec's extra questions (child-process inheritance, untrusted-code sandbox, `--settings` vs repo settings, restricted setting sources/MCP/plugins/hooks, separate `CLAUDE_CONFIG_DIR` auth, `.git/config` and hooks write deny, `gh`/`git push` deny, `claude -p` exiting with its parent). Write `docs/factory/spikes/sandbox-deny.md` with the passing configuration, the full matrix, version tested, residual gaps. Timebox: one day.
- [ ] **Step 6: Commit** `feat(delivery-orchestrator): isolation probe; sandbox spike notes`

### Task 10: Docs, validator, changelog

**Files:**
- Create: `skills/delivery-orchestrator/references/readiness.md`
- Modify: `skills/delivery-orchestrator/SKILL.md` (one short section linking readiness; commands list)
- Modify: `scripts/validate-skills.mjs` (required files: `references/readiness.md`, `core/scripts/lib/readiness.mjs`, `lib/proc.mjs`, `lib/runrecord.mjs`, `lib/limits.mjs`, `lib/factoryhome.mjs`)
- Modify: `CHANGELOG.md`, `docs/guides/delivery-orchestrator.md`

- [ ] **Step 1:** Write `references/readiness.md` (checks table, levels, config keys, gate rule, where the file lives, fix-item meanings). Keep `SKILL.md` under 500 lines.
- [ ] **Step 2:** Run `npm run validate` — expect 0 errors. Run `npm test` in the background — expect all pass.
- [ ] **Step 3: Commit** `docs(delivery-orchestrator): readiness reference, guide and changelog`

### Task 11: Exit-criteria run on real repos

- [ ] **Step 1:** Run `deliver readiness --repeat 2` on three real repos (one expected ready, two not); record level, check results and fix items in `docs/factory/spikes/readiness-trial.md`; apply one fix per not-ready repo and confirm its check flips to `pass`.
- [ ] **Step 2:** Deliver at least 3 real features with run records, run `si.mjs runs-factory`, record attribution coverage (target ≥ 90%, 0 `ambiguous`) in the same file.
- [ ] **Step 3: Commit** `docs(factory): phase 0 exit-criteria trial results`
