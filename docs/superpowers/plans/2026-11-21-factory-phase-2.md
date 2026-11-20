# Factory Phase 2 (run control) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long unattended `factory run` sessions that stay inside limits you set, survive usage limits, crashes and sleep without losing work, stop on command, and surface only what needs a person.

**Architecture:** Run control lives in the Phase 1a driver (`factory.mjs`) and its pure decision table (`lib/driver.mjs`). New small modules hold the policy (`localconfig`, `budget`, `usage`, `interrupt`), the durable state (`runstate`, `attention`, `notify`) and the pure routing. An interrupted builder session is not a crash: the driver WIP-commits, records the interruption in the queue, waits if allowed, then restarts the step with a continue brief.

**Tech Stack:** Node 20+ ESM, zero dependencies, `node:test`, the existing fake `claude` (`tests/fixtures/fake-claude/claude.mjs`), macOS `osascript` and `caffeinate`.

**Spec:** [docs/factory/specs/phase-2-run-control.md](../../factory/specs/phase-2-run-control.md) (revision 2, written before Phase 1a landed). Phase 1a as built: [phase-1-verification-gate.md](../../factory/specs/phase-1-verification-gate.md), `skills/delivery-orchestrator/references/factory-driver.md`.

Paths: `SD` = `skills/delivery-orchestrator`, `S` = `SD/core/scripts`, `L` = `SD/core/scripts/lib`. Commit messages end with the attribution line the session gives.

## Reconciliation with the code as built (rulings the spec cannot make)

The spec predates Phase 1a. Where code already exists or the spec cannot be met as written, this plan rules as follows. Task 13 writes these into spec revision 3.

1. **Lock (P2.5) already exists** (`L/lock.mjs`: pid + start-time, orphan groups). No new lock module. Missing: a read-only `inspect()` and the interactive-`deliver` refusal (Task 9).
2. **No `--resume`.** P0.3 never proved `claude -p --resume`; the continue brief is the only mechanism.
3. **Injection points 3 and 4 (limit "during the CI wait / verification") cannot happen:** no `claude` process runs in those steps. They are tested as stop and driver-kill during CI wait and during verification (Task 12). Points 1 and 2 (mid-build, mid-fix) are tested with the fake `claude` usage limit.
4. **`ci_failed` and `verify_failed` never reach a budget check** (the check runs at session start, when the feature is already `building` or `fixing`). Only `building` and `fixing` get the `awaiting_human` transition, and only for `--kind budget`. Other holds there keep today's "attention and stop" behaviour.
5. **Daily usage layout:** `~/.factory/usage/<YYYY-MM-DD>/<repo-key>.json`, summed on read (one writer per file; no cross-repo write race). Same meaning as the spec's shared daily file.
6. **Existing `attention/<key>.jsonl` stays** as the event log; the new `attention/<key>.md` is the current view with rows removed on resolve.
7. **`--merge` is ignored only when `autonomy.level` is explicitly `L0`.** A legacy `merge.mode: "pr-only"` config keeps accepting `--merge`.
8. **Absent budgets:** feature caps default to 3,000,000 tokens and 400 turns for `factory run`; no day cap when `budgets.day_tokens` is absent (a warning line is printed at start).
9. **`--raise-budget ID`** adds the original caps once more (cap doubles); `ID=N` sets the token cap to N. The held feature returns to `building` or `fixing` through the new driver-only `deliver unhold`.
10. **`factory stop --now`** interrupts sessions and the CI wait. A verification run in progress finishes (it has its own timeouts); this is a documented known gap. All other driver steps last seconds.
11. **Interactive `deliver` guard is a convenience, not a security control** (the driver passes `FACTORY_DRIVER_PID`; the builder has no `deliver` and no FACTORY_HOME access).
12. **A feature interrupted by timeout 3 times is blocked** (a session that always times out must not loop forever).
13. **Unreadable usage or run-state file:** `factory run` refuses to start (fail closed), never treats it as zero.

## Global Constraints

- Node 20+, zero dependencies, ESM; `npm test` (`node --test "tests/validation/*.test.mjs"`) and `npm run validate` (0 errors) pass; `SKILL.md` stays under 500 lines.
- Autonomy: `autonomy.level` is `L0` or `L1`; `L2` and `L3` are rejected naming the phase that adds them (Phase 6, Phase 8). Both `autonomy.level` and `merge.mode` written and disagreeing is an error; only `merge.mode` maps `pr-only`→L0, `squash`→L1; neither: L0.
- Committed budget keys: `budgets.feature.tokens` (10,000 to 1,000,000,000), `budgets.feature.turns` (10 to 5,000). Tokens = input + output + cache creation; cache reads recorded separately.
- Local `~/.factory/config.json`: `wait_for_reset` (bool, default false), `max_wait_h` (0 to 12, default 6), `max_wait_weekly_h` (0 to 168, default 0), `keep_awake` (bool, default true), `fallback_model` (string or null), `budgets.day_tokens`. Unknown keys are errors. `wait_for_reset: true` is refused while the classifier is "fixtures only".
- Interruption kinds: `session` wait and resume when allowed and within `max_wait_h`, else stop; `weekly` stop (wait only if `max_wait_weekly_h` > 0); `model` stop or switch to `fallback_model`; `rate` retry after 1, 2 and 4 minutes, then treat as `other`.
- WIP commit message: `wip(<ID>): interrupted (<kind>)`, hooks disabled. Waiting: sleep in 30-second slices against the wall clock; retry at `reset_at` plus 2 minutes, then every 10 minutes up to `max_wait_h` in total; unknown reset time is now plus 5 hours, marked estimated. `caffeinate -i -w <driver pid>` when `keep_awake`.
- Stop flag `~/.factory/stop/<repo-key>`, checked before every step and every 5 seconds during sessions and waits. Kill: SIGTERM to the process group, SIGKILL after 10 seconds.
- Notifications: repo key, event and count only, never feature content.
- Run record additions: `tokens_by_role`, `turns_by_role`, `cost_usd_by_role` (if available), `budget_hit`, `interruptions` (kind, step, minutes waited, resume method), `stopped_by_user`.

## Review Focus

Failure modes the spec implies but does not pin; each has a test in the owning task.

1. **Sleep or clock jump during a wait** must not stretch or skip the wait (Task 8: fake clock with a +3 h jump).
2. **Limit with no reset time** waits now plus 5 hours and is recorded as estimated (Task 6, Task 8).
3. **Stale stop flag** from an earlier run: `factory run` without `--continue` refuses with the fix line (Task 9).
4. **Interrupted with nothing to commit** (only driver-owned `.implementation/` changes): no empty WIP commit, no error (Task 8).
5. **Unreadable or corrupt usage, run-state or local-config file:** refuse to start, name the file, never read as zero (Tasks 2, 3, 4).
6. **Day rollover at local midnight** during a long run and a cap hit exactly at the cap (Task 3).
7. **`--raise-budget` on a feature that is not budget-held** refuses and changes nothing (Task 9).

---

### Task 1: `autonomy` and `budgets.feature` in the committed config

**Files:**
- Modify: `L/config.mjs` (defaults, `parseConfig`), `S/deliver.mjs` (`init` merge decision near `wantsMerge`), `SD/templates/delivery.json`
- Test: `tests/validation/factory-runcontrol-config.test.mjs` (new)

**Interfaces:**
- Produces: `config.autonomy = { level: 'L0'|'L1', explicit: boolean }`; `config.budgets = { feature: { tokens: number, turns: number } }` (defaults 3000000 and 400). `config.merge.mode` stays consistent with the level (`L1`→`squash`, `L0`→`pr-only`).

- [ ] **Step 1: Write failing tests** in the new file, calling `parseConfig`:
  - `neither key → level L0, explicit false, merge.mode pr-only`
  - `only merge.mode squash → L1 explicit false; only pr-only → L0`
  - `autonomy.level L1 alone → merge.mode squash, explicit true`
  - `autonomy L0 + merge squash → errors contain "autonomy.level and merge.mode disagree"` (and the agreeing pair is accepted)
  - `L2 → error mentions "Phase 6"; L3 → error mentions "Phase 8"; "L9" → generic error`
  - `budgets.feature.tokens 9999 and 1000000001 rejected, 10000 and 1000000000 accepted; turns 9 and 5001 rejected, 10 and 5000 accepted; unknown budgets key rejected; non-integer rejected`
  - `deliver init under explicit L0 ignores --merge (queue.merge false, a warning line says so); a legacy pr-only config still honours --merge` (drive `deliver.mjs init --merge` the way `tests/validation/delivery-orchestrator.test.mjs` does).
- [ ] **Step 2: Run** `node --test tests/validation/factory-runcontrol-config.test.mjs`. Expected: FAIL (unknown key `autonomy`).
- [ ] **Step 3: Implement** the two keys in `parseConfig` (strict `keys()` allowlist, bounds above, mapping rules in Global Constraints) and the `deliver init` rule: `--merge` counts only unless `autonomy.explicit && level === 'L0'`; add the keys to `templates/delivery.json` (`"autonomy": {"level": "L0"}`, the spec's sample budgets).
- [ ] **Step 4: Run** the new file plus `node --test tests/validation/delivery-orchestrator.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): autonomy levels and feature budgets in the committed config`.

### Task 2: Local config and the classifier status

**Files:**
- Create: `L/localconfig.mjs`
- Modify: `L/limits.mjs` (export the status)
- Test: `tests/validation/factory-runcontrol-config.test.mjs`

**Interfaces:**
- Produces: `export const CLASSIFIER_STATUS = 'fixtures_only'` (limits.mjs); `parseLocalConfig(raw, { classifierReal = false } = {}) -> { config, errors }`; `loadLocalConfig(home, opts) -> { config, errors }` (absent file → defaults, unreadable or invalid JSON → an error). `config` shape: `{ wait_for_reset, max_wait_h, max_wait_weekly_h, keep_awake, fallback_model, budgets: { day_tokens: number|null } }` with the defaults in Global Constraints. `day_tokens` bounds 10,000 to 1,000,000,000.

- [ ] **Step 1: Failing tests:** defaults for `{}`; each bound rejected just outside and accepted at the edge; unknown key (top level and under `budgets`) is an error; `wait_for_reset: true` errors with text containing "fixtures only" unless `classifierReal: true`; `loadLocalConfig` on a missing file returns defaults, on a file of `{` returns an error naming `config.json`; a symlinked `config.json` is refused.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `parseLocalConfig` and `loadLocalConfig` (read with `O_NOFOLLOW`, 64 KiB cap like `readJson` callers) and the `CLASSIFIER_STATUS` export.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(factory): local run-control config and classifier status`.

### Task 3: Usage store and budget checks

**Files:**
- Create: `L/usage.mjs`, `L/budget.mjs`
- Test: `tests/validation/factory-runcontrol-budget.test.mjs` (new)

**Interfaces:**
- Produces (usage.mjs): `localDay(date: Date) -> 'YYYY-MM-DD'` (local timezone); `tokensOf(e) -> number` (`in + out + cache_create`); `addUsage(home, repoKey, date, entry) -> void` (entry `{in,out,cache_create,cache_read,turns}`; adds into `usage/<day>/<repoKey>.json`, atomic, private dirs); `dayUsage(home, date) -> { tokens, turns }` summed over all repos; `featureUsage(f) -> { tokens, turns }` summed over `f.sessions`; `class UsageError`. Any unreadable or malformed file under the day directory throws `UsageError` naming the file.
- Produces (budget.mjs): `checkBudget({ feature, caps, day, dayCap }) -> { ok: true } | { ok: false, scope: 'feature'|'day', dim: 'tokens'|'turns', used: number, cap: number }` where `feature` is `featureUsage(f)`, `caps` is `{tokens, turns}` (after any raise), `day` is `dayUsage(...)`, `dayCap` is `number|null`. A counter at or above its cap is not ok (cap reached = stop); feature is checked before day.

- [ ] **Step 1: Failing tests:** `localDay` uses local time (a date at 23:59 local and 00:00 local differ); `addUsage` twice accumulates; two repo keys sum in `dayUsage`; a new day starts at zero (fake `Date` values); a corrupt file throws `UsageError`; `tokensOf` excludes cache reads; `featureUsage` ignores malformed session entries safely (negative or non-number counts as 0); `checkBudget`: below cap ok, exactly at cap not ok, turns cap, feature wins over day, `dayCap: null` never trips.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** both modules (`writeJsonAtomic`, `readJson` from `factoryhome.mjs`; directories 0700 and not symlinks, as `privateDir` does in `factory.mjs`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(factory): daily usage store and runaway-guard budget checks`.

### Task 4: Run state, attention view, notifications

**Files:**
- Create: `L/runstate.mjs`, `L/attention.mjs`, `L/notify.mjs`
- Test: `tests/validation/factory-runcontrol-state.test.mjs` (new)

**Interfaces:**
- Produces (runstate.mjs): `RUN_STATUS = ['running','paused','stopped','finished']`; `readRun(home, repoKey) -> object|null` (throws on a corrupt file); `updateRun(home, repoKey, patch) -> object` (atomic merge into `runs/<repoKey>.json`; fields `run_id, status, pause: { kind, reset_at, estimated }|null, counters, step, session_id, updated_at`; an unknown status throws).
- Produces (attention.mjs): `addAttention(home, repoKey, { id, kind, severity: 'high'|'medium', what, run }) -> void` (`run` is the exact command to run; required); `resolveAttention(home, repoKey, { id, kind }) -> boolean`; `listAttention(home, repoKey) -> item[]`. State is kept in `attention/<repoKey>.json`; every add and resolve re-renders `attention/<repoKey>.md` as a table (Severity, Item, What, Run). Same `(id, kind)` twice is one row.
- Produces (notify.mjs): `notify(event: 'paused'|'stopped'|'finished'|'attention', { key, count }, { run = spawnSync, platform = process.platform } = {}) -> boolean`; runs `osascript -e 'display notification "<fixed text>" with title "factory"'` by argv only, darwin only; the text is built from the event, the key (restricted to `[A-Za-z0-9._-]`) and the count.

- [ ] **Step 1: Failing tests:** `updateRun` merges and keeps other fields; an invalid status throws; a corrupt file makes `readRun` throw; `addAttention` renders a row containing the `run` command, a duplicate adds no second row, `resolveAttention` removes it and the `.md` no longer mentions it; `notify` on darwin calls the injected `run` once with argv `['osascript','-e', <text>]` and the text contains the key and count but not a feature id or title passed in a decoy extra field; non-darwin returns false without calling; a key containing `"` or a newline is rejected.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(factory): run state, attention view and notifications`.

### Task 5: Budget-hold transitions in the queue

**Files:**
- Modify: `L/queue.mjs` (`TRANSITIONS`), `S/deliver.mjs` (`hold`, new `unhold`, help text), `SD/references/states.md`
- Test: `tests/validation/factory-runcontrol-queue.test.mjs` (new)

**Interfaces:**
- Produces: `TRANSITIONS.building` and `.fixing` gain `awaiting_human`; `TRANSITIONS.awaiting_human` gains `building` and `fixing`. `deliver hold ID --reason R --kind budget` accepts `building` and `fixing` only for kind `budget` (other kinds there keep failing as today) and records `f.budget_hold = { from: <state> }`. New driver-only `deliver unhold ID --to building|fixing` (queue must be under `FACTORY_HOME`, like `hold`): requires `awaiting_human` with `hold_kind: 'budget'`, moves to `--to`, clears `budget_hold`, and sets `f.interrupted = { kind: 'budget', step: 'build'|'fix', ts }`.

- [ ] **Step 1: Failing tests:** transition table has the four new edges and no others new; `hold --kind budget` from `building` and from `fixing` parks the feature with `hold_kind: 'budget'`; `hold --kind antigaming` from `building` still refuses; `unhold` from a non-budget `awaiting_human` refuses; `unhold --to fixing` sets `interrupted.step === 'fix'`; `unhold` outside `FACTORY_HOME` refuses; `pickNext` skips dependents of a budget-held feature (existing rule).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the transitions, the `hold` kind check, `unhold`, and update `states.md`.
- [ ] **Step 4: Run** the new file and `node --test tests/validation/delivery-orchestrator.test.mjs tests/validation/factory-driver.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): budget holds park a building or fixing feature`.

### Task 6: Interruption routing and driver decisions

**Files:**
- Create: `L/interrupt.mjs`
- Modify: `L/driver.mjs` (`ACTIONS`, `RESULTS.session`, `sessionResult`, `decide`, `resume`), `S/factory.mjs` only where `sessionResult` callers need the new field (none yet)
- Test: `tests/validation/factory-runcontrol-interrupt.test.mjs` (new); update the usage-limit rows in `tests/validation/factory-driver.test.mjs`

**Interfaces:**
- Produces (interrupt.mjs): `RATE_RETRY_S = [60, 120, 240]`; `routeInterruption({ limit, resetAt, nowMs, local, waitedMs = 0, rateAttempt = 0 }) -> { do: 'wait', untilMs, estimated } | { do: 'retry', afterS } | { do: 'switch_model', model } | { do: 'stop', reason }`. `limit` is `'session'|'weekly'|'model'|'rate'`; `local` is the parsed local config. Rules: `session`: stop when `!wait_for_reset`; else first wait ends at `resetAt` + 120 s (no `resetAt`: now + 5 h, `estimated: true`), later waits (`waitedMs > 0`) last 600 s; stop when `waitedMs` plus the new wait exceeds `max_wait_h`. `weekly`: stop unless `max_wait_weekly_h > 0` and the wait fits. `model`: `switch_model` when `fallback_model` is set, else stop. `rate`: `retry` with `RATE_RETRY_S[rateAttempt]`, then stop with reason mentioning "other".
- Produces (driver.mjs): `sessionResult` keeps the limit kind: `{ step:'session', kind:'usage_limit', limit, resetAt }`. `RESULTS.session` gains `'stopped'` and `'budget'`; `ACTIONS` gains `'interrupt'`. `decide`: session `usage_limit` → `{ do:'interrupt', kind:'usage_limit', limit, resetAt }`; `timeout` → `{ do:'interrupt', kind:'timeout' }` while `f.timeouts` (count, default 0) < 3, else `block`; `stopped` → `{ do:'interrupt', kind:'stop' }`; `budget` → `{ do:'interrupt', kind:'budget', scope }`; `no_result` and `other` keep today's `stop('interrupted')`. A `building` or `fixing` feature with `f.interrupted` set and `last === null` returns `{ do:'build', brief, continue: true }` (`brief` is `'build'` for building, `fixKind(f)` for fixing). `resume`: `building` with `f.interrupted` skips the `reset: true` rebuild (done+ahead+clean still goes to `built`), and the `resumes >= maxResumes` hold does not apply to a feature with `f.interrupted`.

- [ ] **Step 1: Failing tests** for `routeInterruption`: session with wait off → stop; session on with `resetAt` 1 h ahead → `untilMs = resetAt + 120000`, not estimated; no `resetAt` → now + 5 h, estimated; second wait (`waitedMs` > 0) → 600 s; total beyond `max_wait_h: 1` → stop; weekly default stop and weekly with `max_wait_weekly_h: 24` and a 10 h reset → wait; model with and without `fallback_model`; rate attempts 0, 1, 2 give 60, 120, 240 and attempt 3 stops. Driver tests: `usage_limit` result with `limit: 'weekly'` → interrupt action carrying `limit`; `timeout` twice interrupts, the third (`f.timeouts: 3`) blocks; `building` + `f.interrupted` + `null` → `continue: true`; `resumeAction` for `building` with `f.interrupted` and dirty tree → build with no `reset`; same feature with `resumes: 99` is not held.
- [ ] **Step 2: Run, expect FAIL.** Update the existing driver tests that expected `stop('usage_limit')` and `stop('interrupted')` for timeouts to the new actions (spec amends the Phase 1 table).
- [ ] **Step 3: Implement** `interrupt.mjs` and the `driver.mjs` changes.
- [ ] **Step 4: Run** new file and `tests/validation/factory-driver.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): route interruptions and resume interrupted steps`.

### Task 7: Session abort and monotonic timeout

**Files:**
- Modify: `L/sessions.mjs` (`runSession`, `checkArgs`)
- Test: `tests/validation/factory-sessions.test.mjs` (extend)

**Interfaces:**
- Produces: `runSession` accepts `shouldAbort?: () => boolean` and `abortPollMs?: number` (default 5000, minimum 10). When `shouldAbort()` returns true the process group gets SIGTERM, then SIGKILL after `killGraceMs`; the result is `{ ok:false, failure:{ kind:'stopped', resetAt:null }, timedOut:false, ... }`. `sessionResult` (Task 6) maps it to `{ step:'session', kind:'stopped' }`.

- [ ] **Step 1: Failing tests** using the fake `claude` in a hanging mode (use the mode the existing timeout test uses): `abort flag set after 200 ms ends the session with failure.kind 'stopped' within 2 s and the group is gone`; `a stubbed Date.now that jumps +1 hour mid-session does not trigger the timeout (timeoutS 30)`; `shouldAbort that throws is treated as false`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the poll inside the existing `tick` interval (own timestamp from `process.hrtime`, not `Date.now`).
- [ ] **Step 4: Run** `node --test tests/validation/factory-sessions.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): sessions can be aborted from outside`.

### Task 8: Budgets, interruption handling and waiting in the driver

**Files:**
- Modify: `S/factory.mjs` (`makeContext`/`prepare` for local config and clock seam; `builderSession`, `authorOne`, `usageEntry`, `execute`, `loop`, `finish`; new `enforceBudget`, `handleInterrupt`, `wipCommit`, `waitUntil`), `SD/core/prompts` (continue brief text; use the existing prompt-file convention found by `renderPrompt`), `skills/implementer/SKILL.md` (continue brief)
- Test: `tests/validation/factory-runcontrol-driver.test.mjs` (new; follow the harness of `factory-driver.test.mjs`: fake `claude`, local bare origin, `deps` seams)

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces: `ctx.deps.clock = { now(): number, sleep(ms): Promise<void> }` (defaults to `Date.now` and a real timer); `ctx.local` (parsed local config); `usageEntry` also carries `cost_usd`. Functions in `factory.mjs`:
  - `enforceBudget(ctx, f) -> null | { step:'session', kind:'budget', scope }` called before every builder and author session; reads caps from `ctx.policy.budgets.feature` (or the feature's raised cap `f.budget_cap`) and `dayUsage`; a feature hit runs `deliver hold ID --kind budget`, adds an attention row (`kind: 'budget'`, `run`: `factory run --raise-budget ID`), counts nothing toward the circuit breaker; a day hit calls `waitUntil` for local midnight when `wait_for_reset`, else ends the run `stopped` with `stopped: day_budget`.
  - After every session `addUsage(...)` and the `usageEntry` append happen, even for a failed session.
  - `wipCommit(ctx, f, kind) -> { committed: boolean, head: string|null }`: in the builder clone (`bGit`, the hook-free wrapper) stages everything except `.implementation`, `.delivery`, `.skill-runs`, commits `wip(<ID>): interrupted (<kind>)` only when something is staged, returns the head.
  - `handleInterrupt(ctx, f, act) -> { last?, end? }`: runs after `noLiveBuilder`; WIP commit; sets `f.interrupted = { kind, step, session_id, head, ts }` and appends to `f.interruptions`; for `timeout` increments `f.timeouts`; for `stop` ends the run (`status stopped`, exit 2, notify `stopped`, attention row); for `usage_limit` calls `routeInterruption` and then waits (`updateRun` `paused` with `pause.reset_at` and `estimated`, notify `paused`), retries (`rate`), switches the model (`ctx.modelOverride`), or stops with an attention row and notify.
  - `waitUntil(ctx, untilMs) -> 'done'|'stopped'`: loops `clock.sleep(min(30000, remaining))` and re-reads `clock.now()` each slice; checks the stop flag each slice; with `keep_awake` on darwin spawns `caffeinate -i -w <pid>` and kills it afterwards.
  - The result of a normal session end clears `f.interrupted` and resets `ctx.waitedMs`.
  - `loop`: an `act.do === 'interrupt'` runs `handleInterrupt`; `act.continue` makes `briefFor` append the continue brief (feature id, step, "continue from the current branch and the `.implementation/<ID>/` ledger; finish with `result.json`"); a feature with `f.interrupted` is not counted in `f.resumes` (Task 6 rule in `loop`'s resume branch).

- [ ] **Step 1: Failing tests** (fake `claude` `usage-limit` mode exists; add a `first N sessions then done` counter key to `fake.json` if absent):
  - `mid-build limit with uncommitted edits: WIP commit "wip(FEATURE-001): interrupted (session)" holds the edits, the run waits (fake clock), the continue session sees the edits and the brief text, and the feature merges; fix_rounds stays 0`
  - `mid-fix limit (ci_fix): same, no fix round consumed, push happens only after the continued session reports done`
  - `limit with only .implementation/ changes: no WIP commit, no error`
  - `resetAt unknown: run state shows estimated true and untilMs = now + 5 h`
  - `fake clock jumps +3 h inside one sleep: wait ends at the next slice, not 3 h later; a clock that never reaches until stops at max_wait_h`
  - `wait_for_reset off: run stops with kind usage_limit, feature left building with interrupted set, attention row names factory run --continue`
  - `weekly and model kinds stop and notify (injected notify records "stopped"); model with fallback_model passes --model to the next session`
  - `rate: three retries at 60, 120, 240 s on the fake clock, then stops`
  - `timeout interrupt three times blocks the feature`
  - `feature cap: after sessions total tokens reach the cap the feature is awaiting_human, hold_kind budget, its branch has the work committed, an attention row exists, the circuit breaker does not count it, the next independent feature still runs`
  - `day cap: run paused kind day_budget until the next local midnight on the fake clock and resumes; with wait_for_reset off it stops`
  - `day-total file corrupt: factory run refuses before any session` (Review Focus 5)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the functions above in `factory.mjs`, the continue-brief prompt file and the one-paragraph `implementer/SKILL.md` note.
- [ ] **Step 4: Run** the new file, then `tests/validation/factory-driver.test.mjs`. Expected: PASS (update only assertions that depended on the old usage-limit stop).
- [ ] **Step 5: Commit** (two commits are fine: budgets, then interruptions) `feat(factory): budgets, interruption handling and waiting`.

### Task 9: Stop, status, continue, raise-budget, locking guards

**Files:**
- Modify: `S/factory.mjs` (`main`, `parseArgs` bool options, new `cmdStop`, `cmdStatus`, `--continue`, `--raise-budget`, stop-flag checks, async CI wait), `L/lock.mjs` (`inspect`), `S/deliver.mjs` (interactive guard), `L/driver.mjs` (`RESULTS.ci` gains `'stopped'`)
- Test: `tests/validation/factory-runcontrol-stop.test.mjs` (new)

**Interfaces:**
- Produces (lock.mjs): `inspect(repoKey, { home, sys }) -> { state: 'absent'|'live'|'stale'|'unreadable', pid: number|null }` (read-only; never takes or removes the lock).
- Produces (factory.mjs): commands `stop [--now]` and `status [--json]` that identify the repo but do not take the lock or touch the clone (`NO_LOCK` set in `main`); `stopRequested(ctx) -> { now: boolean }|null` reading `~/.factory/stop/<key>`; `run` options `--continue` (bool) and `--raise-budget ID[=tokens]`. Status prints run status and reason, current step, feature states, feature and day usage against caps, next resume time, attention count; `--json` prints the same fields.
- The driver's own `deliver` calls get env `FACTORY_DRIVER_PID=<pid>`. `deliver.mjs`, for every command except read-only ones (`status`, `config`, `readiness --json`, help): if `inspect()` of the queue's repo says `live` and `FACTORY_DRIVER_PID` is not that pid, or the stop flag exists and the pid does not match, it dies with the fix text (`a factory run holds this repository; run factory stop first`).
- `stepCi` becomes `async` and uses `deliverWatch(ctx, args)` (spawn, poll the stop flag every 5 s; on a `--now` flag SIGTERM then SIGKILL after 10 s the deliver process group) returning `{ step:'ci', kind:'stopped' }`, which `decide` routes to `{ do:'interrupt', kind:'stop' }`.

- [ ] **Step 1: Failing tests:**
  - `stop writes the flag; run without --continue refuses with the fix line naming --continue; run --continue removes the flag and carries on` (Review Focus 3)
  - `graceful stop during a session aborts it (Task 7), WIP-commits, ends status stopped exit 2, no new session starts`
  - `stop --now during the CI wait kills the deliver child within 15 s and the run ends stopped; the feature is still pr_open and the next run continues from CI`
  - `after stop no process with the factory clone or work directory as cwd survives, and the app port from app.ready.url is free` (use the survivor and port helpers the Phase 1a tests use)
  - `a second factory run is refused (existing LOCK_HELD path); interactive deliver next/ci/merge refuse under a live lock and under the flag; the driver's own calls succeed; status and config are still allowed`
  - `inspect: absent, live (own pid), stale (dead pid with a different start), unreadable (garbage file) and it never modifies the lock`
  - `--raise-budget FEATURE-001 on a budget-held feature doubles the caps, unholds it to its saved step, and the run continues from the branch; =N sets tokens to N; on a feature that is not held it refuses and the queue is unchanged` (Review Focus 7)
  - `status --json fields and counts match a seeded queue, usage and attention`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** the new file, `tests/validation/factory-driver.test.mjs` and `tests/validation/delivery-orchestrator.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): stop, status, continue, raise-budget and interactive guards`.

### Task 10: Run records move to FACTORY_HOME

**Files:**
- Modify: `L/runrecord.mjs` (`appendRecordTo`, `buildRecord` fields), `S/deliver.mjs` (record writer in driver mode), `skills/skill-insights/core/scripts/si.mjs` (`runs-factory --repo`), `skills/skill-insights/references/metrics.md`
- Test: `tests/validation/factory-runrecord.test.mjs` (extend), `tests/validation/skill-insights.test.mjs` (extend)

**Interfaces:**
- Produces: `appendRecordTo(file, rec)` (private parent dir, `O_NOFOLLOW`, append). In driver mode (`queueInHome()` true) `deliver` appends to `$FACTORY_HOME/records/<repo-key>.jsonl` instead of `<project>/.skill-runs/factory-runs.jsonl`. `buildRecord` adds the Run record additions from Global Constraints (`tokens_by_role` etc. summed from `f.sessions`, `budget_hit` from `f.budget_hold`, `interruptions` from `f.interruptions`, `stopped_by_user`). `si.mjs runs-factory --repo OWNER/NAME` reads that file (latest per `(run, feature)`); `--dir` behaviour unchanged.

- [ ] **Step 1: Failing tests:** driver-mode deliver writes under `records/` and not under `.skill-runs/`; interactive mode unchanged; a symlinked `records/<key>.jsonl` is refused; record fields for a budget-held then continued feature and an interrupted feature; `si.mjs runs-factory --repo o/r` joins tokens as `--dir` does.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): driver-mode run records live under FACTORY_HOME`.

### Task 11: Hard-stop matrix and probe routes

**Files:**
- Create: `L/hardstops.mjs`
- Modify: `S/probe.mjs` (new routes and `--save`), `S/factory.mjs` (print at start), `SD/core/settings/builder.json` only if a row's static test finds a gap
- Test: `tests/validation/factory-runcontrol-hardstops.test.mjs` (new), `tests/validation/factory-probe.test.mjs` (extend)

**Interfaces:**
- Produces: `HARD_STOPS` (array of `{ id, name, mechanism, proof }`, one per P2.2 row, 7 rows); `proof` is `{ kind: 'test', ref }` (a test file name that really exists) or `{ kind: 'probe', route }`. `unprovenRows(probeResult|null) -> row[]` returns probe-proof rows whose route did not come back `denied` in `$FACTORY_HOME/probes/last.json`. `probe.mjs --save` writes that file (`{ ts, routes: { <name>: 'denied'|'leaked'|'error' } }`, private); new routes: write to `stop/`, `runs/`, `usage/`, `records/` and `config.json` under `FACTORY_HOME`, and an outbound connect to a non-local host through Bash. `factory run` prints each unproven row at start and adds one attention row (`kind: 'unproven_hardstop'`, medium).

- [ ] **Step 1: Failing tests:** every `HARD_STOPS` test-proof `ref` names a file that exists and contains the row's id; the builder settings deny `WebFetch`, `WebSearch` and non-role MCP servers (static assertion on `builder.json` / `buildArgv`: `--strict-mcp-config`); `.product/delivery.json` is in G4's protected list and a PR changing a budget is held (antigaming test with a diff touching it); `unprovenRows(null)` returns all probe rows; with a saved result all `denied` returns none; `factory run` output contains each unproven row id; the new probe routes appear in `ROUTES` and report `denied` against a stub target in the existing probe test harness.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(factory): hard-stop matrix with proofs and unproven-row reporting`.

### Task 12: Exit-criteria integration tests

**Files:**
- Test: `tests/validation/factory-runcontrol-exit.test.mjs` (new; reuse the Task 8 harness)

- [ ] **Step 1: Write one test per exit criterion** (names carry the criterion number):
  1. `E1 limit mid-build and mid-fix: pause, resume, finish, no lost commits or edits (git log has the WIP commit squashed away after merge), fix_rounds unchanged`; `E1 driver killed (SIGKILL) during the CI wait and during verification: rerun continues from the same state with the PR and verdict intact` (points 3 and 4, per the reconciliation).
  2. `E2 weekly and model stop and notify; wait_for_reset off stops; day cap pauses and resumes after local midnight (fake clock)`.
  3. `E3 driver killed during a session and during a wait: next start kills the orphan group, no session or app process remains, the run continues`.
  4. `E4 stop --now halts within 60 s, ports free, --continue resumes correctly`.
  5. `E5 feature cap holds with the work committed; --raise-budget continues it`.
  6. `E6 second driver refused; interactive deliver refused under the lock and the flag`.
  7. `E7 a builder PR that edits .product/delivery.json is held (antigaming at built or merge)`.
  8. `E8 every HARD_STOPS row has a passing test or probe or is printed as unproven`.
  9. `E9 SKILL.md under 500 lines`.
- [ ] **Step 2: Run** `node --test tests/validation/factory-runcontrol-exit.test.mjs`. Expected: FAIL only where earlier tasks left a gap; fix those in the owning module (never loosen a test).
- [ ] **Step 3: Run the full suite** `npm test` and `npm run validate`. Expected: all pass, 0 errors.
- [ ] **Step 4: Commit** `test(factory): phase 2 exit criteria`.

### Task 13: Documentation, spec revision, changelog

**Files:**
- Create: `SD/references/run-control.md`
- Modify: `SD/references/config.md`, `SD/references/safety.md`, `SD/references/factory-driver.md` (known-gap list: `stop --now` during verification, unproven hard-stop rows, classifier fixtures only), `SD/SKILL.md`, `SD/templates/delivery.json` (already touched), `docs/guides/delivery-orchestrator.md`, `CHANGELOG.md`, `scripts/validate-skills.mjs` (required-files list), `docs/factory/specs/phase-2-run-control.md` (revision 3: the 13 reconciliation rulings), `docs/factory/specs/phase-1-verification-gate.md` (action-table rows for limit, budget, stop, timeout), `docs/factory/roadmap.md` (Phase 2 status)
- Test: `npm run validate` and the existing doc-consistency tests

- [ ] **Step 1: Write the docs.** `run-control.md`: autonomy levels, budgets, interruption kinds and the continue flow, waiting, stop and kill, attention and status, notifications, the config reference, the "fixtures only" caveat and how to turn `wait_for_reset` on once a real capture exists (then flip `CLASSIFIER_STATUS`).
- [ ] **Step 2: Run** `npm run validate && npm test`. Expected: 0 errors; all tests pass; `SKILL.md` under 500 lines.
- [ ] **Step 3: Commit** `docs(factory): phase 2 run control`.

## Self-review

- **Spec coverage:** P2.1 Task 1; P2.2 Task 11; P2.3 Tasks 3, 5, 8, 9; P2.4 Tasks 6, 7, 8; P2.5 Tasks 9 (lock exists, guard added); P2.6 Tasks 4, 8, 9; run records Task 10; exit criteria 1 to 9 Task 12; documentation and spec amendments Task 13.
- **Names checked across tasks:** `routeInterruption` and `RATE_RETRY_S` (6, 8); `f.interrupted` shape `{ kind, step, session_id, head, ts }` (5, 6, 8, 9); `hold_kind: 'budget'` and `budget_hold` (5, 8, 9, 10); `ctx.deps.clock` (8, 12); `stopRequested` (8, 9); `loadLocalConfig`/`parseLocalConfig` (2, 8); `addUsage`/`dayUsage`/`featureUsage`/`checkBudget` (3, 8); `inspect` (9); `HARD_STOPS`/`unprovenRows` (11, 12).
- **Known trade-offs written down:** reconciliation rulings 1 to 13.
