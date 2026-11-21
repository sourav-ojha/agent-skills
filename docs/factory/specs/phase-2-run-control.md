# Phase 2 spec: Run control

Status: revision 3 (implemented; reconciled with the code as built, see "Revision 3" below). Revision 2 was written before Phase 1a landed and reviewed once. Roadmap: [../roadmap.md](../roadmap.md). Depends on: [Phase 0](phase-0-foundations.md), [Phase 1](phase-1-verification-gate.md) (1a: driver, trust model, action table).

## Goal

Long unattended runs that stay inside limits you set, survive interruptions (usage limits, crashes, sleep), stop when you say stop, never lose work, and only bother you when something genuinely needs you.

| ID | Deliverable |
|---|---|
| P2.1 | Autonomy levels L0 and L1 |
| P2.2 | Hard stops, each with its enforcing mechanism and a test |
| P2.3 | Budgets: runaway guards per feature, one daily cap |
| P2.4 | Interruption handling: wait for usage-limit reset and resume without losing work |
| P2.5 | Kill switch and single-driver locking |
| P2.6 | Attention queue, status, macOS notifications |

Non-goals: L2 and L3 (Phases 6 and 8); mid-session usage kills (deferred until live usage reporting is proven); reading the 5-hour window share; webhook notifications; a launchd service.

## Where it lives

All run control is in the factory driver. Two config files:

| File | Holds | Why there |
|---|---|---|
| `.product/delivery.json` (committed, read from `origin/<base>`) | `autonomy.level`, feature budgets | Repo policy: reviewed like code, can't be changed by a builder PR without a hold |
| `~/.factory/config.json` (local, per machine) | `wait_for_reset`, wait limits, `keep_awake`, daily cap, notifications | Your preferences for this machine and account; changing them needs no PR; never published |

Run state: `~/.factory/runs/<repo-key>.json` (atomic writes): run id, status (`running`, `paused`, `stopped`, `finished`), pause kind and resume time, counters, current step, session id.

Daily usage (rev 3): `~/.factory/usage/<YYYY-MM-DD>/<repo-key>.json`, one file per repo per local day, summed on read, because subscription limits are per account (one writer per file).

## P2.1 Autonomy levels

```json
"autonomy": { "level": "L1" }
```

| Level | Meaning | Today's equivalent |
|---|---|---|
| L0 | Supervised: PRs opened, CI and verification run, nothing merged; everything ready waits in the attention queue | `merge.mode: "pr-only"` |
| L1 | Merge on green: squash-merge when CI, verification (if required) and every hold rule pass; T3 follows the Phase 1 rule | `merge.mode: "squash"` |

- The parser checks the **raw** config: if both `autonomy.level` and `merge.mode` are written and disagree, it's an error. If only `merge.mode` is written, it maps per the table. If neither, the default is L0.
- `L2` and `L3` are rejected with a message naming the phase that adds them.
- (rev 3) L0 ignores `--merge` only when `autonomy.level` is written explicitly as L0; a legacy `merge.mode: "pr-only"` still accepts it. A run that wants merging needs L1 in the committed config. (`--merge --note` remains for the interactive skill without the driver, as today.)
- The readiness minimum applies only when the config has a `readiness` key (Phase 0 D7), so existing `squash` configs keep working.
- New keys are typed and bounded (below); an older installed skill refuses a config with keys it doesn't know, which is the existing strict-parser behaviour and is documented in the upgrade notes.

## P2.2 Hard stops

| Hard stop | Real mechanism | Prompt-level extra | Test |
|---|---|---|---|
| Builder reads secrets (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, keychain, `.env*` except the example) | Sandbox read deny; allowlisted environment with no tokens | Settings deny rules | P0.4 probe, extended |
| Builder reaches production hosts or databases | Network limited to registries and localhost for Bash and for untrusted code; **WebFetch, WebSearch and non-role MCP servers disabled** for the builder | — | Probe: outbound to a non-local host fails via Bash and via each tool |
| Destructive data operations | Only local seeded data is reachable (network rule); migrations are T3 and held | — | Bench: a table-dropping migration is held |
| Merge outside the gate; disabling CI or protection | No GitHub token in the builder's environment, network rule, branch protection requiring `factory/verified`, CI-config changes held | Settings deny `gh`, `git push` | Phase 1a exit 6 |
| Changing autonomy or delivery config | `.product/delivery.json` changes are already held by `deliver` (it treats the config file like a hold path); the driver adds it to G4 so it is also held at merge | — | Existing hold test, plus a driver test: a builder PR raising a budget is held |
| Editing run state, stop flags, local config, verdicts or usage records | All under `~/.factory/`, write-denied to the builder | — | P0.4 probe |
| Editing the run history | Run records move from the repo's `.skill-runs/` to `~/.factory/records/<repo-key>.jsonl` in driver mode | — | Probe (rev 3: `write records/` route) |

Denying `gh` or `git push` by permission pattern alone is a prompt-layer rule; the real controls are no token, the network limit, and branch protection. If P0.4 left any row unproven, `factory run` prints it at start and records it (rev 3: `lib/hardstops.mjs` holds the matrix; the probe proofs are saved with `probe.mjs --save`).

## P2.3 Budgets

Budgets are **runaway guards**, not a precise model of subscription use: raw tokens don't map exactly to window use because models are weighted differently.

Committed (repo policy):

```json
"budgets": { "feature": { "tokens": 3000000, "turns": 400 } }
```

Local (`~/.factory/config.json`):

```json
"budgets": { "day_tokens": 30000000 }
```

- "Tokens" = input + output + cache creation, from each session's final `claude -p` usage. Cache reads are recorded separately. If P0.3 shows `total_cost_usd` is populated on a subscription, it's recorded too, as a model-weighted comparison.
- Bounds: tokens 10,000 to 1,000,000,000; turns 10 to 5,000. Defaults are placeholders until Phase 0 records exist; then the suggested feature cap is 3× the median. (rev 3) Absent committed budgets default to 3,000,000 tokens and 400 turns for `factory run`; an absent day cap means none, with a warning at start.

Enforcement, all between sessions or by session limits:
- Before each session: if the feature or day counter is already at its cap, the session doesn't start.
- Each session runs with `--max-turns` (Phase 1a) and its wall-clock timeout, measured on a monotonic clock that pauses during sleep.
- After each session: counters are updated from its usage.

| Cap | Outcome |
|---|---|
| Feature | (rev 3: only from `building` or `fixing`) Feature → `awaiting_human`, reason `budget`; work stays on the branch (committed by the driver, see P2.4); attention entry; next independent feature continues; **not** counted by the circuit breaker. Continue with `factory run --raise-budget ID[=tokens]` (rev 3: bare ID adds the policy caps once more, so the first raise doubles them; `ID=N` sets the token cap) |
| Day | Run stops `day_budget`; with `wait_for_reset` on, it pauses (kind `day_budget`) until local midnight and replays the refused step |

State transitions added for budget holds (rev 3: only `building` and `fixing`; `ci_failed` and `verify_failed` never reach a budget check): `building`, `fixing` → `awaiting_human` (reason `budget`); `awaiting_human` (reason `budget`) → `building` or `fixing` when `--raise-budget` resumes it, restoring the step it was in.

## P2.4 Interruption handling

### Kinds

| Kind (P0.3 classifier) | Handling |
|---|---|
| `session` (5-hour window) | Wait and resume if `wait_for_reset` is on and the wait is within `max_wait_h`; else stop |
| `weekly` | Stop and notify (waiting days is rarely wanted); waiting only if `max_wait_weekly_h` > 0 |
| `model` (a model-specific cap) | Stop and notify, or switch to `fallback_model` if you configured one |
| `rate` (short-term throttling) | Retry the step after 1, 2 and 4 minutes, then treat as `other` |
| budget, stop, timeout | As in P2.3 and P2.5 |
| `other` | Normal failure, handled by the Phase 1 action table |

`wait_for_reset` defaults to **off**, and cannot be turned on while the classifier is marked "fixtures only" by Phase 0 (no real capture yet); `factory run` says so.

### Interrupted is not crashed

Phase 1's crash-resume rules handle a driver that died without knowing why. An **interrupted** session (usage limit, budget, stop, timeout) is different: the driver knows the session ended early, and the work so far must be kept.

When a builder session is interrupted, the driver:
1. Commits any uncommitted changes on the feature branch as `wip(<ID>): interrupted (<kind>)`, with hooks disabled.
2. Records the interrupted step, kind, session id, and the head sha (rev 3: recorded as `f.interrupted` in the queue **before** the WIP commit, so a failed commit cannot lose the work).
3. On resume, starts the builder with a **continue brief**: feature id, step (build or fix), and "continue from the current branch and the `.implementation/<ID>/` ledger; finish with `result.json`". (rev 3: `claude -p --resume` was never proven, so the continue brief is the only mechanism.)
4. For a fix step, pushes only when the continued session reports `done`. The interruption itself does not use a fix round.

WIP commits are squashed away by the squash merge.

Author and evaluator sessions are restarted from scratch (short, and must not carry partial context). Driver-only steps (CI wait, merge) simply run again; they are already idempotent.

This also amends Phase 1's action table: rows for limit, budget, stop and timeout in `building`, `fixing`, verification, and `factory scenarios` all go to "interrupted" handling above instead of the crash rules.

### Waiting

1. Record `paused`, kind, `reset_at`. The reset time comes from the classifier; text times are read in the local timezone; if unknown, now + 5 hours, marked estimated.
2. Sleep in 30-second slices and compare against the wall clock, so sleep doesn't stretch the wait.
3. With `keep_awake`, run `caffeinate -i -w <driver pid>`. This prevents idle sleep; it does not keep a closed laptop lid awake. The wall-clock check makes a late wake-up harmless.
4. At `reset_at` plus 2 minutes, retry the interrupted step itself (no separate probe session). If it hits the limit again, wait 10 minutes and retry, up to `max_wait_h` in total, then stop.

### Driver death

If the driver dies, nothing is running, because sessions are children of the driver and are killed with it (verified as part of exit criteria; P0.4 confirms whether `claude` exits on a closed pipe). Running `factory run` again takes the lock and continues: a `paused` run keeps waiting, an interrupted step resumes as above, anything else follows the crash rules.

## P2.5 Kill switch and locking

### Lock

(rev 3: already built in Phase 1a, `lib/lock.mjs`; Phase 2 adds a read-only `inspect()` and the `deliver` guard) `~/.factory/locks/<repo-key>.lock`, created with exclusive create, holding the driver pid, the process start time (to survive pid reuse after reboot), and the process groups and ports it started. A lock is stale only if no process with that pid and start time exists. A second `factory run` refuses. Interactive `deliver` commands also refuse while a live factory lock exists for the repo, so you and the driver can't push the same branches (rev 3: a convenience guard, not a security control; read-only commands are exempt).

### Stop

- `factory stop` (graceful): the driver finishes the current driver-only step, starts no new session, interrupts any running session (P2.4 handling), and ends with status `stopped`.
- `factory stop --now`: also interrupts the CI wait immediately (rev 3: a verification run in progress finishes; a known gap).
- The flag is `~/.factory/stop/<repo-key>`. The driver checks it before every step and every 5 seconds during sessions and waits. Interactive `deliver` commands refuse while the flag exists; the driver's own `deliver` calls are not blocked.
- Killing: SIGTERM to the session's process group, SIGKILL after 10 seconds, then kill any remaining process whose working directory is in the factory clone, builder clone or work directory, or whose environment shows this driver's run temps (rev 3: not processes that merely mention those paths), and warn if an app port is still in use.
- `factory run --continue` clears the stop flag and continues the same run. `factory run --raise-budget` is separate (P2.3).

## P2.6 Attention, status, notifications

- **Attention queue:** (rev 3: the existing `attention/<repo-key>.jsonl` stays as the event log; `<repo-key>.json` holds the rows and) `~/.factory/attention/<repo-key>.md` is the current view, same table shape as product-intelligence's attention report. Items: blocked features, held features (T3, G1/G4/G5, protection), budget holds, scenario approvals pending, pauses and stops, unproven hard stops. Each row says exactly what to run. Rows are removed when resolved.
- **Status:** `factory status [--json]`: run status and reason, current step, feature states, feature and day usage versus caps, next resume time, attention count.
- **Notifications:** macOS notification on pause, stop and finish (rev 3: the per-item attention notification is not sent yet). Repo key, event and count only, never feature content.

## Config reference

Committed: `autonomy.level` (`L0` | `L1`), `budgets.feature.tokens`, `budgets.feature.turns`.

Local `~/.factory/config.json`: `wait_for_reset` (bool, default false), `max_wait_h` (0–12, default 6), `max_wait_weekly_h` (0–168, default 0), `keep_awake` (bool, default true), `fallback_model` (string or null), `budgets.day_tokens`. Unknown keys are errors.

## Run record additions

`tokens_by_role`, `turns_by_role`, `cost_usd_by_role` (if available), `budget_hit`, `interruptions` (kind, step, minutes waited, resume method), `stopped_by_user`.

## Testing

- Unit: level mapping on raw config, conflicts, L0 ignoring `--merge`, L2/L3 rejection; key types and bounds; budget checks and daily rollover at local midnight; classifier routing per kind; `wait_for_reset` refused with fixtures-only classifier; wait computation with a fake clock, including a sleep jump; monotonic session timeout not firing across a sleep; WIP commit with hooks disabled; continue brief contents; lock with pid reuse; second driver refused; interactive `deliver` refused under lock or stop flag, driver calls not refused; `--continue` vs `--raise-budget`; attention add/remove; notification text has no feature content.
- Integration with fake `claude`, injecting a usage limit at four points (rev 3: points 3 and 4 are stop and driver-kill during the CI wait and verification, see ruling 3):
  1. mid-build with uncommitted edits;
  2. mid-fix;
  3. during the CI wait (rev 3: stop, as no `claude` runs there);
  4. during verification (rev 3: stop, as no `claude` runs there).

## Exit criteria

1. For each of the four injection points: the run pauses, resumes, and finishes the feature with no lost commits or edits, and the interruption uses no fix round.
2. `weekly` and `model` kinds stop and notify; `wait_for_reset` off stops; a day cap pauses and resumes after midnight (fake clock).
3. Driver killed during a session or a wait: no orphaned session or app process remains, and rerunning continues correctly.
4. `factory stop --now`: halts within 60 seconds, ports free, `--continue` resumes correctly.
5. Feature cap: feature goes to `awaiting_human` with its work committed; `--raise-budget` continues it.
6. Second driver refused; interactive `deliver` refused while the driver runs or the stop flag exists.
7. A builder PR that edits `.product/delivery.json` is held.
8. Every P2.2 row has a passing test or probe, or is printed as unproven.
9. All existing tests pass; validator 0 errors; `SKILL.md` under 500 lines.

If no real usage-limit capture exists, criteria 1–2 are reported as "fixtures only". (rev 3: this is the case; `wait_for_reset` is refused until `CLASSIFIER_STATUS` is `'real'`.)

## Files expected to change

- `skills/delivery-orchestrator/core/scripts/factory.mjs`: run control, `status`, `stop`, `--continue`, `--raise-budget`
- `core/scripts/lib/`: `budget.mjs`, `runstate.mjs`, `interrupt.mjs`, `lock.mjs`, `attention.mjs`, `notify.mjs`, `localconfig.mjs` (new); `config.mjs` (`autonomy`, `budgets`); `sessions.mjs`
- `deliver.mjs`: refuse under a live factory lock or stop flag when called interactively
- `core/scripts/lib/queue.mjs`: budget-hold transitions
- `skills/skill-insights/core/scripts/si.mjs`: `runs-factory` also reads `~/.factory/records/<repo-key>.jsonl` (driver mode)
- `skills/implementer/SKILL.md`: continue brief (done: one input bullet; the prompt is `core/prompts/continue-brief.md`)
- `references/run-control.md` (new), `references/config.md`, `references/safety.md`, `templates/delivery.json`, `SKILL.md`
- `docs/factory/specs/phase-1-verification-gate.md`: action-table rows for interruptions
- `tests/validation/`, P0.4 probe script

## Risks

- **The classifier may stay "fixtures only"**, which keeps `wait_for_reset` off; runs then stop at the limit and you restart them with `factory run --continue`.
- **Token caps are approximate**; they stop runaways, not precise window use.
- **No mid-session kill**: a session can overshoot its feature cap by one session's worth before the cap applies; `--max-turns` and the timeout bound that.
- **A closed lid may suspend the machine**; the wait resumes correctly on wake, just later.
- **Anthropic's terms on unattended subscription use** weren't confirmed. The factory waits for resets; it never rotates accounts or switches to API keys to dodge limits.

## Open questions

1. Once the classifier has a real capture, do you want `wait_for_reset` on for your machine?
2. Should a `fallback_model` be allowed when one model's cap is hit, or always stop?

## Revision 3: reconciliation with the code as built

Revision 2 predates Phase 1a. Where the code existed, or the spec could not be met as written, these rulings apply (they are binding and documented in [run-control.md](../../../skills/delivery-orchestrator/references/run-control.md)).

Plan rulings:
1. **Lock (P2.5) already existed** (`lib/lock.mjs`). Added only a read-only `inspect()` and the interactive-`deliver` refusal.
2. **No `--resume`.** P0.3 never proved `claude -p --resume`; the continue brief is the only mechanism.
3. **Injection points 3 and 4 cannot happen** (no `claude` process runs during the CI wait or verification). They are tested as stop and driver-kill in those steps; points 1 and 2 use the fake `claude` usage limit.
4. **`ci_failed` and `verify_failed` never reach a budget check.** Only `building` and `fixing` get the `awaiting_human` transition, and only for `--kind budget`; other holds there keep attention-and-stop. Later: `hold --kind budget` refuses any other state, and `unhold` requires `budget_hold.from` and `--to` to match (and `from` to be building or fixing).
5. **Daily usage layout:** `usage/<day>/<repo-key>.json`, summed on read.
6. **`attention/<key>.jsonl` stays** as the event log; `<key>.md` is the current view with rows removed on resolve.
7. **`--merge` is ignored only under an explicit `L0`.** Legacy `pr-only` still accepts it.
8. **Absent budgets:** feature caps default to 3,000,000 tokens and 400 turns; no day cap when absent, with a warning at start.
9. **`--raise-budget ID`** adds the policy caps once more (doubles on the first raise); `ID=N` sets tokens to N. The feature returns to its step through the driver-only `deliver unhold`.
10. **`factory stop --now`** interrupts sessions and the CI wait; a verification run in progress finishes (known gap).
11. **The interactive `deliver` guard is a convenience, not a security control.**
12. **A feature interrupted by timeout three times is blocked.**
13. **An unreadable usage, run-state or local-config file refuses the start** (fail closed), never read as zero.

Later rulings from the build ledger:
- **Budget detection and handling are split:** `enforceBudget` only detects; the driver's `interrupt` action does the hold (feature) or the day stop or wait. The template ships `autonomy.level` L1, not L0, to keep the old squash behaviour.
- **`budget_hit` and `stopped_by_user` are sticky** run-record flags: they survive `--raise-budget` and `--continue`.
- **Weekly waiting** is allowed by `max_wait_weekly_h` > 0 alone; it does not also need `wait_for_reset`.
- **The kill sweep is narrowed** to processes whose cwd is in the clones or work dir, or whose environment shows this repository's builder run dir or this driver's own verification run temps. Detection (`leftovers` stop) stays broad. Another repository's run temps are never signalled.
- **Probe proofs are bound** to the target, `FACTORY_HOME` and the builder-settings sha; the secrets row needs one saved target per credential class; a route is saved `denied` only when the control run leaked through the same route; `--from` results are only as trustworthy as the channel (the user runs `--save` themselves).
- **Task 8b interrupted resumes:** crash-resumes of an interrupted feature count in `interrupted_resumes` (cap 3, then `resume_loop`), separate from `resumes`.
- **Timeouts are counted before the decision** (`f.timeouts`), so the third blocks.
- **A failed WIP commit** stops the run as `wip_failed` with `f.interrupted` already recorded; the next run continues without a reset.
- **`--continue`** reads the saved `pause.reset_at` and waits it out; a plain `factory run` after a crash while paused does not (known gap). A stop flag without `--continue` refuses `run` and `scenarios`.
- **`wait_for_reset`** is turned on by flipping `CLASSIFIER_STATUS` in `lib/limits.mjs` from `'fixtures_only'` to `'real'` after a real capture is recorded.
- **`factory scenarios`** writes run state only for its own waits and never overwrites a stopped run's state.
