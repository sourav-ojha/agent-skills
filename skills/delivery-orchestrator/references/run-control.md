# Run control (factory driver, Phase 2)

How a long unattended `factory run` stays inside limits you set, survives usage limits, crashes and sleep without losing work, stops on command, and tells you only what needs a person. The driver itself: [factory-driver.md](factory-driver.md). Hard-stop proofs: [safety.md](safety.md#proving-the-hard-stops). `factory` means `node <skill-dir>/core/scripts/factory.mjs`.

## Autonomy levels

Committed in `.product/delivery.json`: `"autonomy": { "level": "L0" | "L1" }`.

| Level | Meaning |
|---|---|
| L0 | PRs are opened, CI and verification run, nothing is merged. Everything ready waits in the attention queue |
| L1 | Squash-merge on green: CI, verification and every hold rule pass (T3 follows the usual rule) |

- `merge.mode` still works: `pr-only` maps to L0, `squash` to L1, neither written: L0. Writing both `autonomy.level` and `merge.mode` and disagreeing is a config error.
- `L2` and `L3` are rejected, naming the phase that adds them (Phase 6, Phase 8).
- `--merge` is ignored (with a warning) **only** when `autonomy.level` is written explicitly as `L0`. A legacy `merge.mode: "pr-only"` config still accepts `--merge --note`.
- The shipped template uses L1 (the previous template merged on green).

## Budgets

Budgets are runaway guards, not a model of subscription use. Tokens = input + output + cache creation of each session's final usage; cache reads are recorded separately (and cost, when the session reports it).

| Cap | Where | Default |
|---|---|---|
| Feature: `budgets.feature.tokens` (10,000 to 1,000,000,000), `budgets.feature.turns` (10 to 5,000) | committed config | 3,000,000 tokens, 400 turns |
| Day: `budgets.day_tokens` (10,000 to 1,000,000,000), summed over all repositories for the local day | `~/.factory/config.json` | none; `factory run` prints a warning when absent |

The check runs before each session starts (builder: feature and day; author: day only). A session that is already running is not cut short, so a feature can overshoot by one session; `--max-turns` and the session timeout bound that.

- **Feature cap:** the feature is held `awaiting_human` (`hold_kind: budget`), its work stays committed on the branch, one attention row says `factory run --raise-budget ID`, and the next independent feature continues. It does not count toward the circuit breaker. Only a feature in `building` or `fixing` can be budget-held.
- **`factory run --raise-budget ID[=tokens]`:** a bare `ID` adds the policy caps once more to the feature's current caps (the first raise doubles them). `ID=N` sets the token cap to N and keeps the turn cap. It refuses unless a run is in progress, the feature is budget-held, and the new cap is above what the feature already used (when turns are the spent dimension, use the bare form). The feature then returns to the step it was in, continued with the continue brief. The raise is local to that feature and run; it is not written to the committed config.
- **Day cap:** the run stops `day_budget` (exit 2). With `wait_for_reset` on, it instead pauses until the next local midnight and then replays the refused step.

## Interruptions and the continue brief

An interrupted session is not a crash. The driver keeps the work and resumes the step instead of resetting it.

| Kind | Handling |
|---|---|
| `session` limit | wait and resume if `wait_for_reset` is on and the wait fits `max_wait_h`, else stop |
| `weekly` limit | stop, unless `max_wait_weekly_h` > 0 (then wait within that many hours) |
| `model` limit | switch to `fallback_model` once; stop if none is set or the fallback is limited too |
| `rate` | retry after 1, 2 and 4 minutes, then stop (treated as other) |
| `timeout` | continue at once; the third timeout of a feature blocks it |
| `stop` (you ran `factory stop`) | stop |
| `budget` | see Budgets |

For a builder session (`building`, `fixing`), the driver:
1. records `f.interrupted = { kind, step, session_id, head, ts }` in the queue **before** anything else;
2. commits uncommitted work in the builder clone as `wip(<ID>): interrupted (<kind>)` with hooks disabled (nothing is committed when only driver-owned paths changed; a failed commit stops the run as `wip_failed` and the next run continues without a reset);
3. waits, retries or stops as above;
4. starts the builder again with a **continue brief** (`core/prompts/continue-brief.md`): feature id, step, "continue from the current branch and the `.implementation/<ID>/` ledger; finish with `result.json`". There is no `claude --resume`.

The interruption uses no fix round and is not counted as a crash (`resumes`). A feature whose driver crashed three times while interrupted is held `resume_loop` (`interrupted_resumes`, separate from `resumes`). Author sessions restart from scratch; sessions in the CI wait, verification and merge simply run again (no WIP commit). Timeouts are counted before the decision, so the third one blocks.

## Waiting

- The wait is recorded as a run pause (`kind`, `reset_at`, `estimated`) and slept in 30-second slices measured against the wall clock, so sleep or a clock jump does not stretch or skip it.
- First retry at `reset_at` plus 2 minutes; if the limit is hit again, every 10 minutes, up to `max_wait_h` in total (`max_wait_weekly_h` for a weekly limit). An unknown reset time is now plus 5 hours, marked estimated.
- With `keep_awake` (default on), macOS `caffeinate -i -w <driver pid>` runs during the wait. It prevents idle sleep; it does not keep a closed lid awake, and a late wake-up is harmless.
- A day-cap wait is not bounded by `max_wait_h`.
- `factory run --continue` after a stop during a wait first waits out the saved `pause.reset_at`. A plain `factory run` does not (see the known gaps).

### `wait_for_reset` and the classifier

The usage-limit classifier has only been tested against fixtures, not a real limit event. So `wait_for_reset: true` is **refused** (`factory run` and `factory scenarios` refuse to start, naming `config.json`) while `CLASSIFIER_STATUS` in `core/scripts/lib/limits.mjs` is `'fixtures_only'`; without waiting, runs stop at a limit and you restart with `factory run --continue`.

To turn waiting on once a real capture exists: record the capture and validate the classifier against it (`docs/factory/spikes/limit-detection.md`), edit `core/scripts/lib/limits.mjs` so that `CLASSIFIER_STATUS = 'real'` (the driver compares to exactly `'real'`; any other value keeps the refusal), then set `"wait_for_reset": true` in `~/.factory/config.json`.

## Stop, continue, status

| Command | Effect |
|---|---|
| `factory stop` | writes the stop flag `FACTORY_HOME/stop/<key>`. The driver checks it before every step and every 5 seconds during sessions, the CI wait and waits: the running session is interrupted (WIP commit), no new step starts, the run ends `stopped` (exit 2) |
| `factory stop --now` | also interrupts the CI wait immediately. A verification run in progress still finishes (known gap), as do short driver-only steps |
| `factory run --continue` | clears the flag and continues the same run (the only way to clear it). Without `--continue`, `factory run` and `factory scenarios` refuse while the flag exists |
| `factory status [--json]` | run status and reason, current step, pause and next resume time, lock state, stop flag, feature states with usage against caps, day usage, attention count. Read-only; takes no lock |

- **Kill rules:** on a stop the session's process group gets SIGTERM, then SIGKILL after 10 seconds. The sweep then signals only processes whose working directory is inside the builder clone, the driver clone or `FACTORY_HOME/work/<key>`, or whose environment shows this repository's builder run dir or this driver's own verification run temps. A process that merely mentions a path is left alone but still stops the next start (`leftovers`). Afterwards the app ports are checked and a leftover listener is warned about.
- **Single driver:** a second `factory run` for the repository is refused (the lock holds the pid and start time). While the lock is live, or the stop flag exists, interactive `deliver` commands refuse, except read-only ones (`status`, `config`, `readiness --json`). This is a convenience guard, not a security control: the driver passes `FACTORY_DRIVER_PID`, and the builder has no `deliver` and no `FACTORY_HOME` access.

## Attention and notifications

- `FACTORY_HOME/attention/<key>.md` is the current view (a table; each row says exactly what to run; rows are removed when resolved); `<key>.json` holds the rows and the existing `<key>.jsonl` stays the event log. Items: budget holds, stops (`factory run --continue`), `wip_failed`, held and blocked features, unproven hard stops.
- macOS notifications on `paused`, `stopped` and `finished` carry the repo key, the event and a count only, never feature content. (A per-item attention notification exists in `notify.mjs` but the driver does not send it yet.)

## Where things live

All under `FACTORY_HOME` (default `~/.factory`; the builder cannot read or write it).

| Path | What |
|---|---|
| `runs/<key>.json` | run state: `running`, `paused`, `stopped`, `finished`, reason, pause, current step |
| `usage/<YYYY-MM-DD>/<key>.json` | tokens and turns per repository per local day (summed on read) |
| `stop/<key>` | the stop flag |
| `config.json` | local config (below) |
| `records/<key>.jsonl` | run records in driver mode (instead of the repo's `.skill-runs/`); `si.mjs runs-factory --repo OWNER/NAME` reads them |
| `probes/last.json` | saved isolation-probe result |

An unreadable or corrupt usage, run-state or local-config file makes `factory run` refuse to start, naming the file; it is never read as zero.

## Config reference

Committed (`.product/delivery.json`): `autonomy.level`, `budgets.feature.tokens`, `budgets.feature.turns`. A feature that edits this file is held, so a builder cannot raise its own budget.

Local `~/.factory/config.json` (unknown keys are errors; 64 KiB limit; a symlink is refused):

| Key | Meaning | Default |
|---|---|---|
| `wait_for_reset` | wait for a session limit to reset and resume (refused while the classifier is fixtures only) | `false` |
| `max_wait_h` | total hours to wait per interrupted step, 0 to 12 | `6` |
| `max_wait_weekly_h` | hours to wait for a weekly limit, 0 to 168; 0 means stop | `0` |
| `keep_awake` | run `caffeinate` while waiting (macOS) | `true` |
| `fallback_model` | model to switch to when one model's cap is hit, or `null` | `null` |
| `budgets.day_tokens` | day cap, integer 10,000 to 1,000,000,000, or `null` | `null` |

## Hard stops and the probe

Seven hard stops (secrets, network, destructive data, merge gate, delivery config, factory state, run history) are listed with their mechanism and proof in `core/scripts/lib/hardstops.mjs`. Rows proven by a test are covered by the suite. Rows proven by the isolation probe stay **unproven** until you save a probe result: `factory run` prints `unproven hard stop: <id> <name>` at start and keeps one attention row. The run continues.

`node core/scripts/probe.mjs --save` merges a result into `FACTORY_HOME/probes/last.json`. You run the control (outside the builder) and the builder-side step yourself, then `--from probe.json --control control.json --save` yourself, not through an agent. A proof is bound to its target, `FACTORY_HOME` and the builder-settings sha (`builder_settings_sha256`, so changing `core/settings/builder.json` makes the rows unproven again); the secrets row needs one saved target per credential class. The network row needs `--net-host` with a host you choose and may connect to, so it stays unproven until you do. Steps: [safety.md](safety.md#proving-the-hard-stops).

## Run record additions

Each record (`FACTORY_HOME/records/<key>.jsonl` in driver mode) also carries `tokens_by_role`, `turns_by_role`, `cost_usd_by_role` (only when sessions report a cost), `budget_hit`, `interruptions` (`kind`, `step`, `minutes_waited`, `method`) and `stopped_by_user`. `budget_hit` and `stopped_by_user` are sticky: once set on a feature they stay set after `--raise-budget` or `--continue`. Counts and IDs only.
