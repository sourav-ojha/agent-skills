# Spike P0.3: usage-limit detection

Tested on: Claude Code 2.1.325 (macOS). Classifier status: **fixtures only** (no real limit event has been captured yet).

Allowed commands in this spike: `--version`, `--help`, two tiny `claude -p` calls, public docs. No settings were edited, no hooks installed, no limit was provoked. Session ids and paths below are redacted (`<uuid>`).

## Answers

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | `-p --output-format json` on a limit hit | Success shape observed: one JSON object with `type:"result"`, `subtype`, `is_error`, `api_error_status` (null), `terminal_reason` ("completed"), `result`, `session_id`, `usage`, `total_cost_usd`. Limit-hit shape (exit code, `result` text, reset) not seen. Fixtures assume `is_error:true`, `api_error_status:429`, text like "You've hit your session limit · resets 3:45pm". | **unverified (needs user step 2)** |
| 2 | stream-json and `rate_limit_event` | `rate_limit_event` is emitted on every turn, even when allowed: `{type, rate_limit_info:{status:"allowed", resetsAt:<epoch s>, rateLimitType:"five_hour", overageStatus, isUsingOverage, unifiedWindows:{five_hour:{utilization,resetsAt,status}, seven_day:{...}}}, session_id}`. A `rejected` status value is assumed, not seen. | fields **verified**; rejected case unverified |
| 3 | `CLAUDE_CODE_RETRY_WATCHDOG` under `-p` | Names exist in the 2.1.325 binary: `CLAUDE_CODE_RETRY_WATCHDOG`, `_MAX_WAIT_MS`, `_MAX_USAGE_LIMIT_WAIT_MS`, `_USAGE_LIMIT_RECHECK_MS`, `_SCOPE`. Public docs: from v2.1.199 the watchdog raises the API retry default and removes the cap, aimed at unattended sessions. Whether it waits through a usage limit under `-p` was not tested. | existence verified; behaviour **unverified (needs user step 3)** |
| 4 | `StopFailure` hook payload | Docs: fires when a turn ends on an API error; matcher values include `rate_limit`, `billing_error`, `server_error`, `unknown` and others; common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`; hook output and exit code are ignored (cannot block). Event-specific payload fields not confirmed (the fixture uses `error`, `error_details`, `last_assistant_message`, an assumption). | docs only; **unverified (needs user step 1)** |
| 5 | Auto-continue equivalent | Binary strings contain `autoContinueAtUsageLimit` (and a `...Toggleable` flag), suggesting a setting key. Not confirmed in docs or tried. | **unverified (needs user step 4)** |
| 6 | `session_id` and `--resume` | `session_id` is a top-level field in `-p` json and on every stream-json event. `--resume <id>`, `--session-id <uuid>`, `--fork-session`, `--no-session-persistence` exist in `--help`. Resume after a limit hit not tried. | id **verified**; resume-after-limit unverified (step 2) |
| 7 | Share of the 5-hour window used | Readable: stream-json `rate_limit_event.rate_limit_info.unifiedWindows.five_hour.utilization` (0.11 observed) and `seven_day.utilization` (0.66), each with `resetsAt`. Fraction 0 to 1 assumed. Status line and `/usage` not examined. | **verified** (stream-json) |
| 8 | Skill under `-p`; `--verbose` | `--output-format stream-json` without `--verbose` fails: "requires --verbose". With it works. Skill invocation under `-p` not tried (could run long). | `--verbose` **verified**; skill **unverified (needs user step 5)** |
| 9 | Usage fields; `total_cost_usd` | `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` plus `cache_creation.{ephemeral_1h,5m}`, `modelUsage` per model. `total_cost_usd` was populated (non-zero) on this account, with `modelUsage.*.costBasis:"list"`, so it is a list-price estimate, not billed spend. | **verified** (this account) |

Also observed: with default settings the `-p` run emits many `system` hook events in stream-json, and a "no stdin data received in 3s" warning unless stdin is redirected (`</dev/null`); the Phase 1 driver should close stdin.

## Classifier

`skills/delivery-orchestrator/core/scripts/lib/limits.mjs`, `classifyFailure(payload, {now}) -> {kind, resetAt, source}`. Rules: `is_error:true` (or a `StopFailure` hook payload) is required for any non-`other` kind; a non-`allowed` `rate_limit_event` decides first (`five_hour` -> session, `seven_day` -> weekly, any type naming a model, including `seven_day_opus`, -> model); else result text; else 429 / `error:"rate_limit"` -> rate. Reset: epoch field (seconds or ms), else "resets 3:45pm" / "resets Mon 12:00am" in local time, next occurrence after `now`.

Fixtures (`tests/fixtures/limits/`): `real-allowed-stream.json` is a redacted real capture (success case only). Everything else is hand-written from documented/assumed shapes: the `rate_limit_event` fields (above, partly real), the limit message wording (from the product's UI text), and the hook field names. **Treat the limit-hit kinds as unverified until a real capture exists.** Phase 2's "injected limit" exit test therefore exercises fixtures only.

## Capture tooling

`core/scripts/capture.mjs hook` and `capture.mjs wrap -- <claude args>` write redacted payloads (with the classification) to `FACTORY_HOME/captures/`.

## Steps for the user (not run by the agent)

1. Install the hook: add to user settings a `StopFailure` hook, matcher `rate_limit|unknown`, command `node <repo>/skills/delivery-orchestrator/core/scripts/capture.mjs hook`. Leave it on until a session limit hits, then read `~/.factory/captures/`.
2. Use `capture.mjs wrap -- -p "<prompt>" --output-format stream-json --verbose </dev/null` for headless work; after a limit hit, note the exit code, then try `claude -p --resume <session id> "continue"` once the window resets.
3. With `CLAUDE_CODE_RETRY_WATCHDOG=1` set, run a headless call at a limit and record whether it waits and how long.
4. Look for `autoContinueAtUsageLimit` in `/config` or settings and whether `--settings` accepts it.
5. Run `claude -p "/<small-skill>" --output-format json` and record whether the skill runs.
6. Add real payloads to `tests/fixtures/limits/` (redact ids, paths) and flip this doc to "verified".
