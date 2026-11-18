# Readiness (factory phase 0)

`deliver readiness` answers one question before anything runs unattended: can this repository be worked on and merged safely? The answer is a **level** (0 to 4) plus a result per check and a fix list. Design: [docs/factory/specs/phase-0-foundations.md](../../../docs/factory/specs/phase-0-foundations.md).

## Command

```
deliver readiness [--repeat N] [--json]
```
Run from the repository root with `gh` logged in. It fetches, checks `origin/<base>`, prints a summary and saves the result (see "Where it lives"). `--repeat N` (1 to 5) reruns all checks N times (not only the command checks); a check whose status differs between runs becomes `unstable`. `--json` prints the stored document plus `file` and `min_level`. Exit codes: `0` level meets `readiness.min_level` (default 1 when the config has no `readiness` key), `2` it does not, `1` error.

Command checks (C3, C6, C7, C8) run in a temporary worktree of the base tip, removed afterwards, never in your working tree. Commands are argument lists, run without a shell, in their own process group (killed on exit, timeout or signal), with an allowlisted environment: `PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_ENV=test`, `CI=1` and the `KEY=VALUE` lines of `app.env_example`. There are no credential environment variables (`HOME` is passed, so files under it remain readable). `app.env_example` cannot override the pinned keys (`PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_ENV`, `CI`). A command that times out is a failure. A failing command check is retried once: fail then pass is `unstable`, fail twice is `fail`. Port-in-use and leaked-listener failures (C6) are final and are not retried. The fixed timeouts are 900 s for `app.setup` and 600 s for `app.seed`; the port checked comes from `app.ready.url`, or `app.base_url` when `ready` has no url, on `localhost` (both 127.0.0.1 and ::1), 127.0.0.1 as written. Output in reasons is the last 40 lines, redacted (paths, URLs, emails, secrets, long tokens).

## Checks

Status is `pass`, `fail`, `skip` (the config key is absent) or `unstable`. Every non-`pass` level check (C1 to C8) adds a fix item; the advisory A1 gets none. C2 reports a missing `gh` login for `github.account` as a `fail` with the reason; it does not stop the run.

| ID | Level | Check | Passes when |
|---|---|---|---|
| C1 | 1 | Config | `.product/delivery.json` exists, validates and is identical to the copy on `origin/<base>` |
| C2 | 1 | Tools | Node 20+; `gh` is logged in as `github.account` |
| C3 | 2 | Tests run | in a clean worktree of the base tip, `tests.setup` then `tests.all` exit 0 within `tests.timeout_s` |
| C4 | 2 | No tracked secrets | no file tracked on the base matches `.env`, `.env.*` (except the `app.env_example` file), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`; `app.logs_dir` is git-ignored |
| C5 | 3 | CI gate | a CI config exists on the base (CODEOWNERS does not count) and `checks.required` is set or branch protection / rulesets list required checks |
| C6 | 4 | App starts and stops | the port in `app.ready.url` (or `app.base_url`) is free first; `app.setup`, then `app.start` becomes ready within `app.ready.timeout_s`; after stop nothing listens on the port |
| C7 | 4 | Logs on disk | a file under `app.logs_dir` is created or grows while the app runs |
| C8 | 4 | Seed | `app.seed` exits 0, or no seed is declared and the app reaches ready with `app.env_example` alone |
| A1 | advisory | Branch protection | protection or a ruleset on the base lists required checks (`pass`, `fail` or `unknown` when the plan or token cannot read it). Never part of the level |

## Levels

The level is the highest L such that every check at levels 1..L is `pass` (`skip`, `fail` and `unstable` do not pass).

| Level | Meaning | Allows |
|---|---|---|
| 0 | Not configured | nothing unattended |
| 1 | Configured | supervised runs |
| 2 | Tests run | supervised runs |
| 3 | CI gate trustworthy | merge on green |
| 4 | App drivable with a seed-only environment | the later evaluator phase |

## Config keys (`.product/delivery.json`, all optional)

```json
{
  "app": { "setup": ["npm","ci"], "start": ["npm","run","dev"], "stop": null,
           "base_url": "http://localhost:3000", "ready": { "url": "http://localhost:3000/health", "timeout_s": 120 },
           "logs_dir": "logs/", "seed": ["npm","run","seed"], "env_example": ".env.example" },
  "tests": { "setup": ["npm","ci"], "all": ["npm","test"], "timeout_s": 900 },
  "readiness": { "min_level": 3, "max_age_days": 14 }
}
```
- Commands are argument lists. `app.ready` takes exactly one of `url` or `log_pattern` (a regex, at most 200 characters) plus `timeout_s` (1 to 600). `url` and `base_url` must be `http://localhost:<port>` or `http://127.0.0.1:<port>`. `app.stop` null means SIGTERM to the process group, then SIGKILL after 10 seconds. `logs_dir` and `env_example` are relative paths inside the repo (`env_example` is read as environment and never copied to `.env`).
- `tests.timeout_s`: 1 to 3600, default 900. `readiness.min_level`: 1 to 4, default 3. `readiness.max_age_days`: 1 to 90, default 14.
- Unknown keys and wrong types are config errors, as elsewhere in the config.
- A `readiness` key opts the repo in to the merge gate. Without it nothing below changes. The shipped config template does not include it: add it yourself once the repo is ready for the gate.

## Where it lives

The result is written atomically to `$FACTORY_HOME/readiness/<owner>__<repo>.json` (`FACTORY_HOME` defaults to `~/.factory`), outside the repository so a builder agent in the checkout does not edit it. It holds the helper version, base branch name, base sha, config hash (sha256 of the config file on `origin/<base>`), each check's status, reason and duration, the level, the fix list and a timestamp. The helper refuses to write through a symlink. Whether the directory can be made unwritable for the builder is the sandbox question: [docs/factory/spikes/sandbox-deny.md](../../../docs/factory/spikes/sandbox-deny.md). Until that is settled, the stored level for command checks (C3, C6 to C8) is advisory.

## The gate in `deliver init`

It applies only when merging is authorised for the run (`--merge` or `merge.mode`) **and** the config has a `readiness` key. Otherwise `init` is unchanged and only warns when a stored level is below 3.

When it applies, `init` refuses (nothing is created) if:
1. there is no usable stored result for the repository;
2. the result is older than `max_age_days`, or has no valid date;
3. it is dated more than a day in the future (clock skew or an edited file);
4. its config hash differs from the config on `origin/<base>` now ("config changed");
5. it records a different base branch than this run's base (or none);
6. the level is below `min_level`. The level used is `min(computed, stored)`: `init` re-runs C1, C2, C4 and C5 itself (no commands are executed) and the stored level can only be lowered by that re-run, never raised. The refusal prints the fix list and says to run `deliver readiness` again.

On success the level is stored in the queue as `readiness_level`.

## Fix items

One per non-pass check: the check ID, what failed, the config key or file to change, and fixed help text. Nothing is guessed. Typical changes: C1 commit the config to the base branch; C3 make tests pass from a clean checkout with only `env_example`; C4 untrack secrets and ignore `logs_dir`; C5 commit a CI workflow and set `checks.required`; C6 to C8 make the app start, log and seed from a clean checkout.

## Run records

Each feature outcome is appended to `<project>/.skill-runs/factory-runs.jsonl` (self-ignoring, no-follow). This is written even when `SKILL_RUNLOG=off`: it is a separate store from the per-skill run log.
- When: on every transition into `merged`, `skipped` or `blocked`, and on every entry into `awaiting_human`. A feature can have several records; readers keep the latest per `(run, feature)`. A record written when a feature leaves `awaiting_human` (a person merged it, or it was skipped) ends its window at the moment it started waiting, so the wait does not overlap later features.
- `run_id`: `deliver init` assigns one per run (a UTC timestamp plus 6 random hex characters), so separate runs never share a key.
- Fields: `kind: "factory-run"`, `run`, `feature`, `tier`, `outcome`, `reason` (cut at the first colon, 80 characters, URLs and paths removed), `ts_start`, `ts_end`, `wall_ms`, `fix_rounds`, `ci_runs`, `ci_wait_ms`, `pr`, `base_sha`, `merge_sha`, `readiness_level`, `skills` (version and sha256 prefix of the orchestrator and implementer `SKILL.md`) and `project` (a 6-character hash). Metadata only: no prompts, code, paths or command output.
- Tokens are joined later by skill-insights: `node <skill-insights>/core/scripts/si.mjs runs-factory [--dir PROJECT] [--out FILE]` sums transcript tokens (subagent transcripts included) inside each feature's window. Features whose windows overlap are marked `ambiguous` (their shared tokens count in each row: do not sum them), and each run reports what share of the tokens and turns in the run window fall inside a feature window. `--out` writes an enriched JSON-lines copy and refuses to overwrite the source log.

## Failure classifier and probes (spikes)

`core/scripts/lib/limits.mjs` classifies a failed headless run as a usage limit (session, weekly, model, rate) or `other`, with a reset time when one is given. It is tested on fixtures only; no real limit event has been captured yet. `core/scripts/capture.mjs` (`hook` for a StopFailure payload, `wrap -- <claude args>`) saves redacted failure payloads to `$FACTORY_HOME/captures/` so real ones can be collected. `core/scripts/probe.mjs` is a rerunnable isolation probe: from inside a builder session it tries 13 routes to read a protected directory or write to another and reports `denied` or `leaked`. Findings and caveats: [limit-detection.md](../../../docs/factory/spikes/limit-detection.md), [sandbox-deny.md](../../../docs/factory/spikes/sandbox-deny.md).
