# Phase 0 spec: Foundations

Status: revision 2, after one independent review. Roadmap: [../roadmap.md](../roadmap.md).

## Goal

Before anything runs unattended, know whether a repo can be worked safely, and have the plumbing every later phase measures with.

| ID | Deliverable | Type |
|---|---|---|
| P0.1 | Readiness check: levels 0–4, per-check results, fix list, merge gate | Feature |
| P0.2 | Run record: one line per feature outcome, joinable to token data | Feature |
| P0.3 | Limit-detection spike and failure classifier | Spike + small feature |
| P0.4 | Sandbox deny proof, delivered as a rerunnable probe | Spike |

Non-goals: the evaluator, external scenarios, budgets, wait-and-resume, the kill switch (Phases 1–2); fast-feedback checks such as affected-test selection (Phase 4).

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Readiness is a `delivery-orchestrator` command, `deliver readiness`, not a new skill | The orchestrator owns the gate and the config; one helper, one config file |
| D2 | App and test commands are declared in `.product/delivery.json` and verified by running them | Detecting "how to start this app" is guesswork; running declared commands is deterministic |
| D3 | Readiness is a level (0–4) plus per-check results, not a weighted score | Levels map directly to the autonomy a repo may use |
| D4 | The readiness result is stored outside the repo, in `~/.factory/readiness/<repo-key>.json`; `init` re-runs the cheap checks itself | A file inside `.delivery/` can be edited by the builder agent; outside the repo it can be write-denied (P0.4) |
| D5 | Run records go to `.skill-runs/factory-runs.jsonl` | Already self-ignoring and local; kept separate from `.delivery/` so queue resets and run-state edits don't touch history |
| D6 | Token figures are joined later from transcripts by `skill-insights` | The helper cannot see tokens; skill-insights already parses transcripts |
| D7 | The gate applies only when merging is authorised and the config opts in | Existing `init` behaviour and tests stay unchanged; repos opt in by adding a `readiness` key |

## P0.1 Readiness check

### Config additions (`.product/delivery.json`)

All optional. A missing key makes the matching check `skip`. Unknown keys and wrong types are errors, as for the rest of the config.

```json
{
  "app": {
    "setup": ["npm", "ci"],
    "start": ["npm", "run", "dev"],
    "stop": null,
    "base_url": "http://localhost:3000",
    "ready": { "url": "http://localhost:3000/health", "timeout_s": 120 },
    "logs_dir": "logs/",
    "seed": ["npm", "run", "seed"],
    "env_example": ".env.example"
  },
  "tests": {
    "setup": ["npm", "ci"],
    "all": ["npm", "test"],
    "timeout_s": 900
  },
  "readiness": { "min_level": 3, "max_age_days": 14 }
}
```

- Commands are argument lists, run without a shell, like `local_checks`.
- `ready` takes either `url` (HTTP 2xx) or `log_pattern` (regex matched in the app's output). `ready.url` and `base_url` must be `http://localhost` or `http://127.0.0.1` with an explicit port.
- `app.stop` is optional. When null, stop means SIGTERM to the process group, then SIGKILL after 10 seconds.
- `base_url` is recorded for the Phase 1 evaluator.
- `readiness` present means the repo opts in to the gate (D7).

### Command environment

Readiness commands (setup, tests, app, seed) run with an allowlisted environment only: `PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_ENV=test`, `CI=1`, plus the key/value pairs in `env_example` if set. No `GH_TOKEN`, cloud credentials or other inherited variables. `env_example` is read and passed as environment; it is never copied to `.env`. This is the same environment the Phase 1 evaluator will use.

### Checks

Each check returns `pass`, `fail`, `skip` (not configured) or `unstable`, with a reason and, unless `pass`, a fix item.

| ID | Level | Check | Pass when |
|---|---|---|---|
| C1 | 1 | Config | `.product/delivery.json` exists, validates, and equals `origin/<base>`. A missing file is `fail` |
| C2 | 1 | Tools | Node 20+; `gh` logged in as the configured account (non-fatal check, unlike `useAccount`) |
| C3 | 2 | Tests run | In a temp worktree of the base tip: `tests.setup` then `tests.all` exit 0 within `timeout_s`; duration recorded |
| C4 | 2 | No tracked secrets | No tracked file matches the secret patterns (`.env`, `.env.*` except the `env_example` file, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`); `logs_dir` is git-ignored |
| C5 | 3 | CI gate | At least one CI config on the base branch (same paths as `CI_PATHS`) **and** `checks.required` is non-empty or branch protection/rulesets on `base` list required checks |
| C6 | 4 | App starts and stops | In a temp worktree: port of `ready.url` is free first (else `fail`, to avoid a false pass from an already-running server); `app.setup`, then `app.start` reaches `ready` within its timeout using the allowlisted environment; stop leaves no process listening on that port |
| C7 | 4 | Logs on disk | During C6, at least one file under `logs_dir` is created or grows |
| C8 | 4 | Seed | `app.seed` exits 0 before C6, or no seed is declared and the app reaches ready with `env_example` alone |

Advisory, not part of the level: **A1 branch protection** — queries `repos/{o}/{r}/branches/{b}/protection` and `repos/{o}/{r}/rules/branches/{b}`; reports `pass`, `fail` or `unknown` (when the plan or token can't read protection). Personal private repos on GitHub Free often can't have protection, so making it mandatory would make level 3 unreachable.

**Level** = the highest L such that every check at levels 1..L is `pass`. `skip`, `fail` and `unstable` count as not passing.

| Level | Meaning | Allows |
|---|---|---|
| 0 | Not configured | Nothing unattended |
| 1 | Configured | Supervised runs |
| 2 | Tests run | Supervised runs |
| 3 | CI gate trustworthy | Merge on green |
| 4 | App drivable with seed-only environment | Phase 1 evaluator |

### Behaviour

- `deliver readiness` runs every check, prints a short summary and writes the result atomically to `~/.factory/readiness/<repo-key>.json`, where `<repo-key>` is `owner__repo` from the GitHub remote. Contents: helper version, base sha, config hash, per-check result and duration, level, fix list, timestamp.
- `deliver readiness --repeat 2` runs the command checks twice and compares results, used for exit criterion 1.
- Command checks (C3, C6–C8) run in a temporary worktree of the base tip, removed afterwards, never on the user's working tree. Processes run in their own process group and are killed on exit, timeout or signal. A process still listening on the port after stop is reported in C6's reason.
- A command check that fails is retried once. Fail then pass is `unstable`; fail twice is `fail`.
- Output and fix items include at most the last 40 lines of command output, passed through the same redaction used by skill-insights (`redactText`). Environment values are never printed.

### Gate in `deliver init`

Applies only when both are true: merging is authorised for this run (`q.merge` after `--merge`, `merge.mode` and protected-base handling), and the config has a `readiness` key. Otherwise `init` behaves as today and, if a readiness file exists with a lower level than 3, prints a warning.

When the gate applies, `init`:
1. Reads `~/.factory/readiness/<repo-key>.json`.
2. Refuses if the file is missing, older than `max_age_days`, or its config hash differs from the current config.
3. Re-runs C1, C2, C4 and C5 itself (cheap, no commands executed) and caps the level at what they prove now.
4. Refuses if the resulting level is below `min_level` (default 3). The refusal prints the fix list and the command to re-check.
5. Stores the level in the queue as `readiness_level`.

Until P0.4 proves `~/.factory/` can be write-denied to the builder, the stored level for command checks (C3, C6–C8) is advisory; the spec for Phase 1 decides whether the evaluator re-runs C6 itself.

### Fix list

One item per non-pass check: check ID, what failed, the config key or file to change, and fixed help text for that check. No inferred values.

## P0.2 Run record

### When a record is written

On every transition into `merged`, `skipped` or `blocked`, and on every entry into `awaiting_human`, from all code paths that cause them: `transition()`, `merged()`, `block()`, dependency skips in `pickNext()`, and merges discovered by `refresh()`. Each record is keyed by `(run, feature)`; a feature can have several records (for example `awaiting_human`, then `merged`). Readers keep the latest record per key.

### Fields

| Field | Source |
|---|---|
| `kind` | Always `"factory-run"` (no `event` key, so `si export` does not ingest these as skill events) |
| `run`, `feature`, `tier`, `outcome`, `reason` | Queue state |
| `ts_start`, `ts_end`, `wall_ms` | First `next` for the feature, and this transition |
| `fix_rounds`, `ci_runs`, `ci_wait_ms` | Queue state; `ci_runs` and `ci_wait_ms` are new counters updated on every `ci` call, not only on timeouts |
| `pr`, `base_sha`, `merge_sha` | Queue state |
| `readiness_level` | From the queue (set at `init`) |
| `skills` | For `delivery-orchestrator` and `implementer`: `metadata.version` from the installed `SKILL.md` plus a sha256 prefix of the file (the version string alone doesn't change between edits) |
| `project` | `sha1(path.replace(/[^A-Za-z0-9]/g, '-')).slice(0, 6)` — the same hash skill-insights computes from the transcript folder name |
| `session` | Session id if P0.3 finds a reliable way to read it; otherwise absent |

Metadata only: no prompts, code, paths or command output. `lib/runrecord.mjs` copies the no-follow append logic from `runlog.mjs` rather than importing it, because `runlog.mjs` must stay byte-identical across skills.

### Token join

New `skill-insights` command: `si.mjs runs-factory` (a separate command name, because the current argument parser treats any `--x` as taking a value).
- Reads `factory-runs.jsonl`, keeps the latest record per `(run, feature)`.
- For the matching project hash, sums transcript tokens (input, output, cache read) and turns within `[ts_start, ts_end]`, **including subagent transcripts** (where Claude Code stores them is part of the work; skill-insights currently reads only top-level `*.jsonl`).
- Overlapping windows in one project are reported as `ambiguous`, never split.
- Prints a table; with `--out FILE` writes an enriched copy. Never edits the original.

## P0.3 Limit detection (spike, then classifier)

Timebox: half a day for the spike; passive capture stays on afterwards.

Questions, answered for the installed Claude Code version with evidence:
1. Headless `claude -p --output-format json` on a usage-limit hit: exit code, `is_error`, `subtype`, `result`, `terminal_reason`, `api_error_status`, any reset time.
2. `--output-format stream-json`: whether `rate_limit_event` appears, and its fields.
3. Whether `CLAUDE_CODE_RETRY_WATCHDOG` and its usage-limit wait and recheck variables work under `-p`.
4. What the `StopFailure` hook receives on a rate-limit failure.
5. Whether the interactive auto-continue setting has a settings-file or CLI equivalent.
6. How to read the `session_id` from `-p` output, and whether `claude -p --resume <id>` works after a limit hit.
7. Whether the share of the 5-hour window used can be read at all (status line fields, `/usage`), since Phase 2 budgets depend on it.
8. Whether a skill can be invoked under `claude -p`, and whether `--output-format stream-json` needs `--verbose`.

Method: a `StopFailure` hook and a headless wrapper that save redacted failure payloads to `~/.factory/captures/`, left on during normal use until a session-limit event (and, if possible, a weekly one) is captured.

Deliverables:
- `docs/factory/spikes/limit-detection.md`: answers, version tested, evidence, unknowns.
- `classifyFailure(payload) → { kind: 'session' | 'weekly' | 'model' | 'rate' | 'other', resetAt: ISO | null, source }`, pure, with fixtures from real captures and from documented shapes.

If no real capture exists by the end of Phase 0, the classifier is marked unverified, and Phase 2's "injected limit" exit test will only exercise fixtures. That limitation must be carried into the Phase 2 spec.

## P0.4 Sandbox deny proof (spike)

Timebox: one day.

Question: can a builder session be configured so it can neither read `~/.factory/scenarios/<repo>/` or `~/.factory/work/` nor write anywhere under `~/.factory/`, by any route, while the evaluator can read scenarios?

Also answered here, for Phase 1:
- Whether the sandbox of a session is inherited by child processes it starts (Phase 1 runs builder, author and evaluator as separate `claude -p` processes from a non-LLM driver, so each needs its own settings).
- An **untrusted-code sandbox** for anything from a feature branch (tests, local checks, the app): writes only inside its worktree and a per-run temp directory; network to package registries during setup and to the app's own port on localhost while running. On macOS the candidates are Claude Code's own sandbox runtime or `sandbox-exec` profiles.
- Whether `--settings` deny rules win over a repo's own `.claude/settings*.json`, and how to start a session with restricted setting sources, only chosen MCP servers, and plugins and hooks disabled.
- Whether a separate `CLAUDE_CONFIG_DIR` per role keeps subscription auth working, so author and evaluator transcripts land outside the builder's reach.
- Whether the builder can be denied writes to `.git/config` and `.git/hooks`, and denied running `gh` and `git push`.

Routes to probe from inside a builder session:
- Claude Code tools: Read, Grep, Glob, WebFetch with `file://`, subagents, MCP filesystem tools if installed.
- Shell: `cat`, `cp`, `find`, `tar`, `mdfind`, `qlmanage`, `node -e`, `python -c`, `git -C <path>`, hard links, a symlink created inside the repo pointing into the denied path.
- Escapes: the Bash tool's ability to run a command outside its sandbox, and whether a setting disables it; `open` and `osascript` launching processes outside the sandbox; hooks and MCP servers, which may run unsandboxed; clipboard.
- Leaks from the evaluator side: the evaluator's own transcripts under `~/.claude/projects/` (which would contain scenario text), and any evaluator output written to shared `/tmp`.
- Writes: creating or editing any file under `~/.factory/` (readiness, captures, scenarios).

Candidate configurations, in order: Claude Code permission deny rules plus its Bash sandbox filesystem restrictions; the builder as a separate macOS user without access to `~/.factory/`; the builder in a container without the path mounted.

Deliverables:
- `docs/factory/spikes/sandbox-deny.md`: the configuration that passed, the full matrix, version tested, residual gaps.
- A rerunnable probe script that a builder session runs, which reports per route `denied` or `leaked`. Phase 1 uses it as a regression test.

If no configuration passes, the Phase 1 spec uses the strongest one and states the remaining gap.

## Testing

- Unit tests: check logic, level calculation, gate conditions (gate off by default, on only with merge plus `readiness`), staleness and hash mismatch, fix items, run-record write points (one test per code path listed in P0.2), no-follow writes, token join including `ambiguous`.
- Existing `init` tests must pass unchanged.
- The fake `gh` gains `api repos/.../branches/.../protection` and `.../rules/branches/...` responses, including 404.
- Fixture apps for C6–C8: one that becomes ready, one that never does, one that ignores SIGTERM, one that writes no logs, one that is ready only on every other start (for `unstable`), and one that spawns a detached child that keeps the port.
- A test proves shell metacharacters in configured commands are not interpreted.
- A test proves inherited environment variables (for example a fake `GH_TOKEN`) are not visible to readiness commands.

## Exit criteria

1. Readiness tested on 3 real repos (one ready, two not). `--repeat 2` gives identical results. Each fix item, once applied, flips its check to `pass`.
2. `init`: unchanged without `readiness` or without merge; refuses below `min_level`, on a stale or mismatched file, and when the re-run cheap checks lower the level (tests).
3. Run records: every terminal or waiting transition in a test run produces a record, across all listed code paths.
4. Token join on at least 3 real features: at least 90% of transcript tokens in each run window are attributed to a feature, subagent transcripts are included, and there are 0 `ambiguous` results in serial runs.
5. `limit-detection.md` and `sandbox-deny.md` exist with evidence; the classifier passes its fixtures; the probe script runs and reports.
6. All existing tests pass; validator has 0 errors; `delivery-orchestrator/SKILL.md` stays under 500 lines (details in `references/readiness.md`).

## Files expected to change

- `skills/delivery-orchestrator/core/scripts/deliver.mjs`: `readiness` command, gate in `init`, run-record writes, new CI counters
- `skills/delivery-orchestrator/core/scripts/lib/`: `readiness.mjs` (new), `runrecord.mjs` (new), `config.mjs` (new keys)
- `skills/delivery-orchestrator/references/readiness.md` (new), `references/config.md`, `templates/delivery.json`, `SKILL.md`
- `skills/skill-insights/core/scripts/si.mjs` and lib: `runs-factory`, subagent transcripts; its references
- `tests/validation/`: new tests, fixture apps, fake `gh` extensions; `scripts/validate-skills.mjs` required files
- `docs/factory/spikes/*.md` and the probe script

## Risks

- **Writing the config is extra setup** for each repo. Mitigation: clear fix items and a commented template.
- **Starting an app can have side effects** (ports, files, outbound calls). Mitigation: temp worktree, allowlisted environment, port-free precheck, process-group kill, localhost-only readiness.
- **Limit events are hard to trigger on demand**, so P0.3 may close with documented shapes only.
- **Time-window token join** can misattribute when you work in the same project during a run; it reports `ambiguous` instead of guessing.
- **The readiness file is advisory** until P0.4 proves write-deny.

## Open questions

1. Is `min_level` 3 right for merge on green, rising to 4 once Phase 1 lands?
2. Do you want readiness to run automatically before each unattended run, or only on demand (current spec)?
