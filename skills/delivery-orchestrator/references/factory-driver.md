# Factory driver

`factory` means `node <skill-dir>/core/scripts/factory.mjs`. It is a plain Node process (no LLM) that runs verified delivery: it starts each LLM role as its own `claude -p` session, runs `deliver` as a subprocess for every queue step, verifies, and merges only on a passing verdict. The gate itself (scenarios, verdicts, G-checks): [verification.md](verification.md).

Code: `core/scripts/factory.mjs`, `core/scripts/lib/driver.mjs` (decision table, pure), `core/scripts/lib/lock.mjs`, `core/scripts/lib/sessions.mjs`. Settings: `core/settings/builder.json`, `core/settings/author.json`. Author prompt: `core/prompts/scenario-author.md`.

## Commands

| Command | What it does |
|---|---|
| `factory scenarios [--only IDS] [--dir D] [--base B]` | Authors, lints and stores hidden scenarios for the ready specs on `origin/<base>` ([verification.md](verification.md#hidden-scenarios)) |
| `factory scenarios --approve ID --by NAME [--dir D] [--base B]` | Approves current scenarios (`scenario_approval: human`) |
| `factory run [--only IDS] [--limit N] [--continue] [--raise-budget ID[=TOKENS]] [--dir D] [--base B]` | Runs the queue: build, PR, CI, verification, merge. Resumes a queue in progress; `--only` and `--limit` (1-1000) apply to a new run only. `--continue` clears a stop flag; `--raise-budget` releases a budget hold ([run-control.md](run-control.md)) |
| `factory stop [--now]`, `factory status [--json]` | Stop the running driver; show run state, usage against caps and attention ([run-control.md](run-control.md#stop-continue-status)) |

`--dir` is a checkout of the repository (default: the current directory). Only its identity is used: `gh repo view` names the repository and its `origin` URL must point to the same one. `--base` overrides the base; otherwise `base` from the config on the default branch, else the default branch.

| Exit | `factory run` | `factory scenarios` |
|---|---|---|
| 0 | every feature merged or skipped (or none ready) | done |
| 1 | refused or error before anything unsafe (prints `refused:` and one `fix:` line per problem) | a refusal, criteria errors, a rejected reply or a failed session |
| 2 | stopped mid-run (usage limit, timeout, leftovers, CI unconfirmed, an error in a step), or finished with a feature blocked or awaiting a person | usage limit (run again later) |

The benchmark runner (`bench/factory/run.mjs`) has its own codes, including 3 (every case as expected, but not a result).

Terminal output is states, IDs and counts only: `<ID> <state> -> <action> (<brief>)`, `attention: <ID> <state> (<kind>)`, `stopped: <kind>`, `features: <state> <n>, ...`. Spec, scenario, prompt and builder text are never printed; `error:` lines have paths replaced with `<path>`.

## Refusals at start (`factory run`)

All read from `.product/delivery.json` on `origin/<base>`; each prints a fix line.

| Needs | Why |
|---|---|
| `verification.required: true` | `deliver merge` then insists on a verdict |
| `readiness.min_level: 4`, and a stored readiness result at level 4 for this base | the app must start, log and seed from a clean checkout; `deliver init` re-checks the result |
| `local_checks: []` | `deliver built` runs local checks outside the untrusted-code sandbox; move them to CI (`checks.required`) |
| `checks.required` does not name `factory/verified` | it is posted only after CI passes, so CI would wait for ever |
| branch protection (or a ruleset) on the base requires `factory/verified` | so no other route can merge; needs a public repository or a plan with protected private branches |
| `github.host` equals the origin host | the token is offered to that host only |
| current approved scenarios for every picked feature (re-linted now) | [verification.md](verification.md#approval-and-binding) |
| no live orphan process group or leftover work dir from an earlier run | stop them first. A new run refuses (exit 1); a queue in progress stops before `deliver next` or any session (exit 2, attention for an active feature) |
| a stored queue, if any, is for this repository and base | otherwise reset it (`DELIVER_QUEUE=<queue> node deliver.mjs reset --yes`) |
| a repository name without `__` | the repo key `<owner>__<repo>` must round-trip |

Also refused: a `FACTORY_HOME` that is a symlink, owned by another user or group/world writable; a lock held by a live run; an untrusted driver clone (below). Merging still needs `merge.mode: "squash"` in the base config: the driver never passes `--merge`. Every start prints a warning that `factory/verified` is a plain commit status (see [verification.md](verification.md#factoryverified)).

## Before the first run

Measured on a real repository (Claude Code 2.1, git 2.52, macOS). Each item stops a run on its own:

1. **A dedicated factory home.** Sessions refuse (`settings_unsafe`) a user `settings.json` (in the home's `.claude` folder) with anything beyond `$schema`, `model`, `env` (allowlisted names), `permissions.deny`, `cleanupPeriodDays`, `includeCoAuthoredBy`, and an empty `enabledPlugins` or `sandbox`. Hooks, a status line or plugins, as most personal setups have, refuse every session. Make a separate home whose `.claude` folder holds a `settings.json` of `{}`, log in there once yourself (`HOME=<home> claude`, then `/login`), and start `factory` with `HOME=<home>`. On macOS the login lives in that home's own keychain, so the home cannot be moved afterwards.
2. **`gh` logged in for that home** (`HOME=<home> gh auth login`), as the configured `github.account`: your usual login is in your real keychain and is not visible there. Give the home a `~/.ssh` (a link to yours works) if `origin` uses SSH.
3. **Dependencies installed in the builder clone.** The builder has no network. After the first run creates `<FACTORY_HOME>-builder/<owner>__<repo>`, install there once (for example `pnpm install --frozen-lockfile`) and again whenever the lockfile changes. Without it the builder reports blocked.
4. **Start `factory` from a shell that never changed into a clone.** The leftover scan counts any process naming the builder clone or its run dir in its arguments, environment or working directory, `PWD` and `OLDPWD` included: a script that did `cd <builder clone>` and then left counts, and the run stops as `leftovers`. Use `git -C <dir>` in scripts.

## Layout

`FACTORY_HOME` comes from the driver's environment (default `~/.factory`), is resolved to an absolute real path, and is created 0700; `deliver` subprocesses get that resolved path.

| Path | What |
|---|---|
| `FACTORY_HOME/clones/<key>` | **Driver clone**: a plain clone owned by the driver user. `deliver` runs here (`--dir`), as do merges and verification worktrees. The builder never works in it |
| `<FACTORY_HOME>-builder/<key>` (or `$FACTORY_BUILDER_HOME/<key>`) | **Builder clone**: a second plain clone where builder sessions run. Must resolve outside `FACTORY_HOME` and not contain it, because the builder settings deny every read and write of `FACTORY_HOME` |
| `<builder root>/run/<key>/<ID>-*` | per-session run dir with the session's `TMPDIR` |
| `FACTORY_HOME/queues/<key>.json` | the queue (`DELIVER_QUEUE` for `deliver`) |
| `FACTORY_HOME/locks/<key>.lock` | the lock |
| `FACTORY_HOME/scenarios/<key>/`, `verdicts/<key>/` | scenarios, verdicts |
| `FACTORY_HOME/work/<key>/<ID>-<sha>` | verification worktrees |
| `FACTORY_HOME/tmp/`, `trash/` | run temps and bundles; quarantine before deletion |
| `FACTORY_HOME/run/author/`, `run/settings/` | empty author cwd per session; per-run settings files (0600) |
| `FACTORY_HOME/attention/<key>.jsonl` | attention event log `{at, feature, state, kind}`; `<key>.json` and `<key>.md` hold the current rows and view (Phase 2) |
| `FACTORY_HOME/runs/`, `usage/<day>/`, `stop/`, `records/`, `probes/`, `config.json` | run state, usage, stop flags, run records, probe result, local config ([run-control.md](run-control.md#where-things-live)) |
| `FACTORY_HOME/readiness/<key>.json` | stored readiness result |

`<key>` is `<owner>__<repo>`.

**Commits move between the clones only as git bundles** in `FACTORY_HOME/tmp`, created and applied by the driver with gitSafe (`bundle create`/`bundle unbundle`, then `checkout -f -B` and `clean -fd`). There is never a fetch from the builder clone, so its config, hooks and upload-pack never run. Both clones get `gc.auto 0` (a plain gc writes a commit-graph, which the merge gate refuses); the builder clone's `.git/info/exclude` lists `.delivery/` and `.implementation/`.

**Driver clone preflight**, before every fetch and every `deliver` call: a real directory owned by this user; `.git` a real directory; the common dir is its own `.git`; the gitsafe config allowlist; no grafts, `shallow`, alternates, commit-graph, `config.worktree`, replace refs or hooks; `origin` resolves to exactly the pinned URL (rebuilt from host and repository: `https://<host>/<repo>.git` or `ssh://<user>@<host>/<repo>.git`) and has no `pushurl`. Otherwise refuse; the fix is to delete the clone, and the next run makes a fresh one.

**Before checkout in the driver clone**, the incoming commit's top-level tree may not track `.delivery`, `.implementation` or `.skill-runs` (compared case-insensitively), nor any top-level dot entry with a character outside printable ASCII, space included (APFS folds case, Unicode case variants such as U+017F and normalisation forms). After checkout, those paths must not be symlinks and the run-record file's dev:ino must be unchanged. Otherwise the driver clone goes back to the base and the feature is blocked.

**Credentials.** `gh` and https git use the token of `github.account` (held in memory, offered only to the pinned host through `gh auth git-credential`), else gh's own login. The first clone of an https remote uses the account named in the checkout's config; if the base config names another, the run is refused.

## Lock and start sweeps

`FACTORY_HOME/locks/<key>.lock` (0600, `locks/` 0700) holds the pid, its start time (`ps:<lstart>` on macOS, `proc:<ticks>` on Linux), a token and every process group the run started (sessions record their group on spawn). A lock whose holder is alive is `LOCK_HELD`. A dead holder's lock is taken over, and its recorded groups are killed, after checking the group leader's start time against the recorded one (a reused pgid is never signalled). A garbled lock, a start time from the other source, or a takeover marker left by a dead taker fail closed: remove the file by hand. `factory scenarios` takes the same lock.

Then (`factory run` only): `FACTORY_HOME/trash` is emptied; each `work/<key>/*` dir is moved to the trash and deleted when no process carries its path (then `worktree prune`); `tmp/*` the same, but only when no other repository's lock file exists (tmp is shared). Groups still alive count as `orphans_alive`; dirs still in use count as `leftover_worktrees`. With either, a new run refuses and a queue in progress stops (`leftovers`), whatever its features' states, before `deliver next` or any session.

## Roles and sessions

| Role | cwd | Gets | Can write | Settings |
|---|---|---|---|---|
| Builder | the builder clone | the brief (below), the repo | the repo (commits on its branch), `.implementation/<ID>/`, `.delivery/pr-<ID>.md` | `core/settings/builder.json` |
| Scenario author | an empty dir under `FACTORY_HOME/run/author/` | the spec items as data | nothing: returns JSON | `core/settings/author.json` |
| Evaluator | Phase 1b; not implemented | | | |

Briefs (prompt; fix briefs are also written to `.implementation/<ID>/fix-brief.md` in the builder clone, because the builder cannot read `FACTORY_HOME`):

| Brief | Content |
|---|---|
| `build` | feature id and spec path; use the implementer skill unattended; write the PR description to `.delivery/pr-<ID>.md` |
| `local_fix` | failing local check names and bounded tails (unused while `local_checks` must be empty) |
| `antigaming_fix` | the G-ids that fired (G2/G3) |
| `ci_fix` | failing CI check **names only** (no log tail) |
| `symptom_fix` | the symptom brief, recomputed from the stored verdict |

Every brief ends with the result contract: write `.implementation/<ID>/result.json` (`{"status":"done",...}` or `{"status":"blocked","question":"..."}`), commit on the checked-out branch, never push or open a PR. The driver deletes `result.json` before every session, reads builder files without following links (regular file, one link, size-capped), and takes the tier from the implementer ledger (`T2`, only ever raised).

### Running a session

`runSession({ role, cwd, prompt, settingsFile, configDir?, maxTurns, timeoutS, model?, tmpDir?, home?, onSpawn? })` runs:

```
claude -p <prompt> --output-format stream-json --verbose --max-turns N --settings <file> \
  --setting-sources user --strict-mcp-config --permission-prompts none [--model M]
# author only: --tools "" --no-session-persistence
```

Turn and time limits come from `verification.max_turns` and `verification.session_timeout_s` (defaults: builder 200 turns / 1800 s, author 40 / 900); models from `verification.model`.

- Argv only, never a shell. stdin is `/dev/null`. The process gets its own process group, registered with the proc cleanup registry (killed when the driver exits or gets SIGINT/SIGTERM/SIGHUP) and recorded in the lock.
- Timeout: measured with `process.hrtime` (monotonic; on macOS it does not advance while the machine sleeps). On timeout: SIGTERM to the group, SIGKILL after a grace period.
- The stream is parsed line by line. Lines longer than the cap (`maxLineChars`, 8 Mi UTF-16 chars) are dropped and `truncated: true` is set. The last `result` event wins.
- Returns `{ ok, sessionId, result, usage: {in, out, cache_create, cache_read}, turns, costUsd, failure, timedOut, truncated, exitCode, signal }`. It never throws for a failed session, only for bad arguments. `costUsd` is Claude Code's list-price estimate, not billed spend.
- `failure.kind`, in this order of precedence: `timeout`, `spawn_failed`, `settings_unsafe`, `unsafe_binary`; `max_turns` (`subtype: error_max_turns`, even with `is_error: true`); a result with another error subtype is classified on its own text; otherwise `session`, `weekly`, `model`, `rate` or `other` from `classifyFailure` on an `is_error` result or a `rejected` rate event; `no_result` (no `result` event). The first four classifier kinds are a usage limit for the driver.
- `ok` needs a `result` event with `subtype: "success"`, `is_error: false` and exit code 0 (an observed auth failure reports `subtype: "success"` with `is_error: true`).
- Nothing from the stream or stderr is logged. The author's `result` text holds the scenarios; the driver stores it under `FACTORY_HOME` and never prints it.
- Before spawning, the user settings file that `--setting-sources user` loads (`settings.json` in `CLAUDE_CONFIG_DIR`, else in the home Claude Code config dir) is checked against an ALLOWLIST: top-level `$schema`, `model`, `cleanupPeriodDays`, `includeCoAuthoredBy`; `env` with only `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `MAX_THINKING_TOKENS`; `permissions.deny` only; `enabledPlugins` and `sandbox` only when empty. Any other key refuses the session without spawning (`settings_unsafe`, key names only, cut to 64 characters, never values). The file is also refused when it, or its dir, resolves inside the session's cwd or `tmpDir`, or cannot be parsed. **This refuses on most real setups** (user hooks, a status line, plugins). That is intended until gap 15 is proven.
- The binary is resolved to an absolute path once. `PATH` keeps absolute entries only and drops any entry inside the session's cwd. A `claude` inside the cwd is refused (`unsafe_binary`); a missing one is `spawn_failed`. Unknown options throw. `home` (default: the parent's `HOME`) is the child's `HOME` and the home whose user settings are linted; the driver passes the same `home` to `materialiseSettings`.
- Arguments that look like options are refused: a prompt starting with `-`, a model name outside `[A-Za-z0-9._:[\]-]`, a settings path that is relative, a symlink, not JSON, or fails `checkSettings`.

Environment: only `PATH`, `HOME`, `LANG`, `TMPDIR`, `USER`, `LOGNAME` and `SHELL` reach claude, plus `CLAUDE_CONFIG_DIR` when the caller passes `configDir` (author only; the driver does not). `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_*`, `NPM_TOKEN`, `ANTHROPIC_API_KEY` and the rest are never passed. Measured on macOS with Claude Code 2.1.325: subscription auth is in the login keychain and needs `USER`, `LOGNAME` and `SHELL` as well (which of the first two was not isolated).

### Settings files

`materialiseSettings(role, { factoryHome, repoDir, home, runDir })` writes a per-run copy under `FACTORY_HOME/run/settings/` (0600). It replaces `{{FACTORY_HOME}}`, `{{HOME}}`, `{{REPO}}`, `{{CLAUDE_DIR}}` (the home Claude Code config dir), `{{GITDIR}}` and `{{GIT_COMMON}}` with absolute paths (and adds the realpath form when it differs). A symlinked or malformed `.git` throws; so do unknown placeholders, relative paths and paths with glob or rule characters. In `Read(...)` and `Edit(...)` rules `//` starts an absolute path.

Builder (candidate A of `docs/factory/spikes/sandbox-deny.md`):
- `permissions.defaultMode: acceptEdits`, `disableBypassPermissionsMode: disable`, `blockWritesOutsideWorkingDirectories: true`, no `allow` and no `ask` rules.
- Deny `Read`/`Edit`/`Write` of `FACTORY_HOME`.
- Deny `Read` (rule AND sandbox `denyRead`, in both `~/` and absolute forms) of: credential stores (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`, `~/.docker/config.json`, `~/.claude.json`, `~/.git-credentials`, `~/.netrc`); in `~/.claude*`: `.credentials.json`, `projects`, `todos`, `file-history`, `sessions`, `session-env`, `shell-snapshots`, `paste-cache`, `tasks`, `backups`, `ide`, `history.jsonl`; every entry present in the home Claude Code config dir except `skills`, `agents`, `commands` and the memory file (`plugins` is denied while `enabledPlugins` must be empty); every HOME entry starting with `.claude` other than the config dir; and the real path of every denied path that resolves elsewhere. A config entry name with glob, rule or control characters, or an unlistable config dir, fails closed.
- `materialiseSettings` fails closed when a read deny contains the repo, the `runDir` or a readable config-dir entry (so the run dir must be outside `FACTORY_HOME`, as the builder root is), or a readable config-dir entry resolves inside the repo.
- Deny `Edit` of `~/.claude*` and `~/.claude.json` (user settings would change later sessions).
- `.git`: deny `Edit` (and sandbox `denyWrite` for the gitdir and common dir) of `config`, `hooks`, `info`, `modules`, `commondir`, `config.worktree`, `objects/info` and `worktrees`, at any depth; deny `Edit` of any `.git` below the top level; deny `Write(**/.git/**)`, `Write(**/.git)` and `NotebookEdit(**/.git/**)`. The top-level `.git` objects, refs and index stay writable by Bash on purpose: the builder must `git commit` (Claude Code merges `Edit(...)` denies into the sandbox `denyWrite`, so `Edit(**/.git/**)` would stop every commit; a test enforces this).
- Deny `Bash` for `gh`, `git push` (also with options before `push`), `*factory.mjs*` and `*deliver.mjs*`. Deny `WebFetch` and `WebSearch`.
- `disableAllHooks: true`, `enableAllProjectMcpServers: false`, no MCP servers.
- Sandbox: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, no `excludedCommands`, no allowed network domains (`allowLocalBinding` for tests that open a port).

Author: every built-in tool denied (`Bash`, `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`, `Task`) plus `--tools ""`; hooks off; no network; nothing persisted (`--no-session-persistence`, so the scenarios never land in a transcript the builder could read).

`checkSettings` is an ALLOWLIST of keys (top level `permissions`, `disableAllHooks`, `enableAllProjectMcpServers`, `sandbox`, `$schema`, named sub-keys only). It refuses any other key; a Read deny without a sandbox `denyRead` twin, or a `denyWrite` entry without an `Edit` deny twin; an `allow` rule next to a file-path deny; `ask` rules and bypass mode; a disabled sandbox, an unsandboxed escape, `excludedCommands` or network domains; leftover placeholders.

## Decision table

`nextAction(feature, lastResult, run)` decides from the feature's state after the last step and that step's result. Anything unknown (state, result, fact, limit) holds.

| State | Last result | Action |
|---|---|---|
| queued | none | `deliver next` (or stop `run_stop` when the queue's stop flag or circuit breaker is set) |
| building | none / next ok | builder session (`build`) |
| building | session done | anti-gaming at built, then `deliver built` |
| building | session blocked or max turns | `deliver block` with the question (≤200 chars, kept in the queue, never printed); attention |
| building | G2/G3 at built | builder session (`antigaming_fix`) once; again → block |
| building | `local_check_failed` | builder session (`local_fix`) up to `max_fix_rounds + 1` attempts, then block |
| built | none / built ok | `deliver pr` with the builder's `.delivery/pr-<ID>.md` (or a stock body) |
| pr_open | none / pr ok / push ok / merge stale or updated | G1/G4/G5 recorded at built and not overridden → hold `antigaming`; else `deliver ci` |
| pr_open | ci timeout | `deliver ci` again (deliver blocks it when `--ci-budget` is spent) |
| ci_failed | ci failed | `deliver fix`, builder session (`ci_fix`); no rounds left → block |
| fixing | session done | `deliver push` (bundle to the driver clone first) |
| ci_passed | ci passed / unverified-allowed | verification |
| ci_passed | verify pass | post `factory/verified`, then → `verified` |
| ci_passed, verify_failed | verify fail | → `verify_failed`, `deliver fix`, builder session (`symptom_fix`); no rounds left → block |
| ci_passed | verify threw | hold `verification` (no fix round) |
| verified | verified ok | `deliver merge` |
| awaiting_human | ci unconfirmed | stop `ci_unconfirmed`; attention |
| awaiting_human | merge held | attention (kind = the feature's `hold_kind`, else `merge`), next feature |
| any | session usage limit, timeout, stop, budget | `interrupt` (Phase 2): WIP commit, wait or retry or stop, continue brief; see [run-control.md](run-control.md#interruptions-and-the-continue-brief) |
| any | session no result, other | stop `interrupted`: in building or fixing the work is first kept (WIP commit, `f.interrupted` with kind `other` or `no_result`), so the next run continues the step |
| any | settings_unsafe / spawn_failed / unsafe_binary | hold `settings_unsafe` / `environment` |
| any | a step's `error` | hold `error` |

CI and verification share `max_fix_rounds`. A `hold` goes through `deliver hold` when the state can go to `awaiting_human` (anti-gaming holds carry `--sha` and `--ids`, so `retry --note` can override exactly those); otherwise (queued, building, built, ci_failed, fixing, verify_failed) the run writes an attention entry and stops, leaving the state. The driver writes three transitions itself: `ci_passed → verified`, `ci_passed → verify_failed`, and the reopen to `pr_open`.

Unexpected throws in a step (a gitSafe refusal in the builder clone, a missing branch, a lost lock) write an attention entry and stop the run with exit 2. A process from a builder session still alive in the builder clone or its run dir (scanned before every git call there and before verification) stops the run as `leftovers`.

## Resume rules

A feature left in an ACTIVE state by an earlier run goes through `resumeAction(feature, facts, run)` once. `orphans_alive`, `leftover_worktrees` and `resumes` are required in every state; a missing or malformed fact holds.

| State | Rule |
|---|---|
| any | orphans or leftovers → stop `leftovers`. Resumed 3 times already (`MAX_RESUMES`) after crashes → hold `resume_loop` |
| building | branch ahead of base, `result.json` done and tree clean (deliver's pathspec: `.implementation` and `.delivery` excluded) → built. Result blocked → block. Otherwise reset the branch to base and build again |
| built | head equals `built_sha` → pr; else hold |
| pr_open | PR exists → the pr_open row above; else hold |
| fixing | head moved since the last CI run, tree clean, result done → push; otherwise a new fix session (no new `deliver fix`: the round was counted) |
| ci_passed | PR head ≠ `ci_sha` → an anti-gaming hold recorded at built and not overridden holds first; else reopen to `pr_open`, CI again. Stored verdict for that head with current hashes: pass → post `factory/verified`; fail → fix (a stored fail is not re-rolled); absent or mismatched → verify |
| verified | PR head = `ci_sha` and verdict pass → merge; else the anti-gaming hold first, then reopen, CI and verification again |
| other | as from a fresh start |

`resumes` counts crashes only. It goes up by one each time a run resumes a feature, and back to 0 when that run then ends through the driver's own exit path (any stop, hold, block or the end of the queue: a usage limit, timeout, `no_result` or `leftovers` stop is an interruption, not a crash). Only a run that dies (SIGKILL, power loss, an error that escapes the loop) keeps the count, so `resume_loop` means three resumed runs in a row died. The `resume_loop` stop itself neither counts nor resets. Features that end merged, skipped or blocked keep their last count as a record.

Way out of `resume_loop`: in `building`, `built`, `fixing` and the other states that cannot wait for a person, the run stops with an attention entry and the state left as it is. Once the cause is fixed, either set the feature's `"resumes"` to `0` in `FACTORY_HOME/queues/<repo>.json` (no run in progress: the lock is free) and run again, or give it up with `deliver skip <ID> --reason R` (or `deliver block`) through `DELIVER_QUEUE=FACTORY_HOME/queues/<repo>.json node deliver.mjs ... --dir <driver clone>`. In states that can wait, the feature is held `awaiting_human` and leaves the run's way; the same queue edit applies before `deliver retry`.

## Run records

Each record in `.skill-runs/factory-runs.jsonl` (in the driver clone; see [readiness.md](readiness.md)) also carries, from `verificationFields`, re-validated so a forged queue value is dropped: `verify_runs`, `verify_ms`, `verdict` (`pass`/`fail`/null), `verdict_sha`, `gap_criteria` (criterion IDs that passed CI but failed verification), `antigaming` (G-ids that fired), `override_note` (boolean: a person overrode a G-hold), `sessions` (`[{role, id, in, out, cache_create, cache_read, turns}]`, builder sessions only). IDs and counts only.

## Known gaps

Everything below is **unverified (needs user step)** unless it says "measured" or "by design". Steps: `docs/factory/spikes/sandbox-deny.md`.

Session isolation:
1. **Deny rules are not proven to block.** The settings were accepted by a real `claude -p` run (measured); whether each rule blocks each route (Read, Grep, Glob, WebFetch `file://`, subagents, Bash children) is unverified (steps 2-5).
2. **Rule path syntax.** `//abs` in `Read(...)`/`Edit(...)`, and `~/.claude*/...` globs matching `~/.claude-<x>/`, come from the docs (step 3).
3. **Sandbox globs.** Whether globs merged from `Edit(**/.git/...)` rules are enforced by the macOS sandbox is unverified (step 7).
4. **`Write(...)`/`NotebookEdit(...)` rules.** Belt and braces; if Claude Code maps them into `denyWrite`, `git commit` fails (fail closed, step 7).
5. **Nested `.git` via Bash** relies on the merged globs (gap 3). The driver's gitSafe worktree walk is the authority.
6. **Textual Bash rules.** `Bash(gh *)` matches command text; a wrapper bypasses it. The barriers are no network domains, no `GH_TOKEN`, and the `~/.config/gh` read deny (step 7).
7. **`--max-turns`, `--permission-prompts none`, `--tools ""`, `--no-session-persistence`** were accepted by a real run (measured); `--max-turns` is not in `claude --help` 2.1.325.
8. **User plugins and skills load** under `--setting-sources user` (measured). Whether `disableAllHooks` stops plugin hooks is unverified, so non-empty `enabledPlugins` refuses the session.
9. **`CLAUDE_CONFIG_DIR` and auth** (step 6): unverified, so `configDir` is not used and the author runs with `--no-session-persistence`.
10. **API-key or token auth** is not passed through.
11. **Orphans if the driver is SIGKILLed.** Recorded groups are killed on the next start (tested). A process that leaves its group (`setsid`) is not reached by the kill; the survivor scan (by path, argv, environment and cwd) catches it and stops the run. A process that clears its environment, rewrites its argv and leaves the path is not found.
12. **No network for the builder**: dependencies must already be installed in the clone ([Before the first run](#before-the-first-run)).
13. **`blockReadsOutsideWorkingDirectories` is not set** (the builder reads the implementer skill outside the repo); `FACTORY_HOME` and transcripts are denied by name.
14. **The max-turns result shape** is from docs, not a capture.
15. **`disableAllHooks` is unproven** against hooks and a status line in user settings, and against plugin hooks (step 5). Until both are proven the allowlist refuses them, and the factory refuses on a machine with either (by design).
16. **No secret scan before push.** Read denies cover known credential stores only; other secrets (other repos' `.env`, browser profiles, `~/Library`, unlisted token files, the keychain via `security`) stay readable, and a builder could commit one. The driver pushes without scanning the branch diff.
17. **Managed settings** (`managed-settings.json`) and a user-level `settings.local.json` are not linted.
18. **`shell-snapshots` deny** may break the Bash tool (step 2); if Bash fails, it is the first suspect.
19. **Case-insensitive APFS.** The deny rules name paths in lower case; whether `~/.SSH` or `HISTORY.JSONL` bypass a rule or the sandbox is unverified (step 13). On the driver side, driver-owned names are compared case-insensitively and non-ASCII dot entries are refused (tested).

Driver and gate:
20. **`factory/verified` is spoofable**: a plain commit status anyone with status write access can post. Only an App-bound required check prevents that; the verdict file re-checked by `deliver merge` is the authority.
21. **Git objects.** Forged loose objects or a crafted pack `.idx`/`multi-pack-index` are not detected. The driver clone's `.git` must be a directory (a `.git` file redirect is refused there and in the builder clone); in an interactive `deliver merge` checkout a `.git` file is not checked.
22. **macOS only in practice.** Verification needs `sandbox-exec` and refuses elsewhere. The survivor scan needs `/bin/ps -E` and `/usr/sbin/lsof`; where either is missing or fails, every scan counts a survivor (fail closed), so the driver cannot run. The Linux `/proc` lock start time is unit-tested only, never run on Linux.
23. **Large clones.** gitSafe's worktree walk stops at 100,000 entries and refuses; a builder clone with a big `node_modules` refuses every worktree-touching git call there (fail closed).
24. **CI-fix brief has check names only**: `deliver ci` fetches no logs.
25. **Not in run records:** author session usage (there is no queue at authoring time), `verify_tokens` and `flaky_count` from the spec.
26. **Setup-phase network** reaches any host on ports 80/443, LAN and cloud-metadata addresses included (SBPL cannot express "public only").
27. **tmp sweep** is skipped while any other repository's lock file exists, stale or not.
28. **`deliver`'s own git is plain git** (not gitSafe), with the driver's environment, in the driver clone. It is protected only by the clone preflight before each `deliver` call (config allowlist, no hooks, metadata, origin pin); `deliver merge`'s gate and changed-file list do use gitSafe. A clone changed between the preflight and a git call inside one `deliver` run is not re-checked.
29. **`local_checks` are refused** in factory runs rather than sandboxed (by design, until `deliver built` can sandbox them).

Phase 2 (run control, [run-control.md](run-control.md)) additions:
30. **`stop --now` during verification** does not interrupt it: the verification run in progress (it has its own timeouts) and short driver-only steps finish first. Sessions, waits and the CI wait are interrupted.
31. **Unproven hard-stop rows.** Rows proven only by the isolation probe stay unproven (printed at start, one attention row) until you save a probe result. The network row needs a reachable host of your choice (`--net-host`); the tool-layer half (WebFetch, WebSearch, MCP) is a static check, not a live probe.
32. **The usage-limit classifier is fixtures only**, so `wait_for_reset` cannot be turned on. Runs stop at a limit; `factory run --continue` resumes.
33. **A plain `factory run` after a driver crash while paused** does not wait out the saved reset: it continues the interrupted step at once, hits the limit again and waits again (one extra short session). Only `--continue` waits out the saved `pause.reset_at`.
34. **The stop sweep kills by cwd and sandbox environment only.** A leftover that merely mentions a clone or work path in its arguments is not killed, and neither is one with a controlling terminal whose cwd is in a clone (a person's shell or editor); both stop the next start (`leftovers`) until you end them. A process of yours with its cwd in a clone and no controlling terminal is killed. A process that clears its environment and leaves the path is not found.
35. **Crash-resume of an interrupted feature** is capped separately (`interrupted_resumes`, 3, then `resume_loop`); a session that always times out is blocked after three timeouts.
36. **A dying driver leaves its session running.** The session is in its own process group, so it outlives a driver that is SIGKILLed or crashes (exit criterion E3) and runs until the next start kills the recorded group, up to `session_timeout_s` and its max turns. Its usage is never recorded, so the feature and day caps undercount. A crash during a session that was not interrupted rebuilds that step from the base (crash rules): the session's work is lost.
37. **HEAD off the feature branch.** A builder that switched the clone to another branch gets no WIP commit when it is interrupted (one line, a `wip_skipped` row); continuing the step checks the feature branch out again and its uncommitted edits are lost.
38. **An empty `objects/info/commit-graphs` directory is allowed.** A builder session's clone ends up with one; it holds no graph, so it cannot change a parent. A file in it, or a symlink in its place, is still refused. Which process creates it was not pinned down.
39. **Unix sockets in the sandbox temp dir.** The builder may open unix sockets only in Claude Code's sandbox temp dir (`/tmp/claude-<uid>`, both spellings on macOS): test runners such as tsx open an IPC socket there, and without it every test that launches the CLI fails with `EPERM`. That dir is uid-wide, not per run (Claude Code fixes the sandbox `TMPDIR`; `CLAUDE_CODE_TMPDIR` does not move it), so the builder can reach any socket another process of the same user puts there. Measured on macOS: none is there by default (Claude Code keeps its own sockets in `/tmp/cc-socks`), and a symlink in the dir to an outside socket is refused (`EPERM`), as is connecting to that socket directly. A socket that another process of the user (an interactive session's command, a dev server started from a Claude Code temp folder) opens under that dir is reachable; if you run such services, leave the factory off while they run or remove the entry from `builder.json` and let socket-using tests report blocked. On Linux the sandbox cannot allow a socket by path, so the setting has no effect there. Changing `builder.json` changes its sha: save a new isolation probe result.

CLI scenarios ([verification.md](verification.md#cli-scenarios)):
40. **Readiness C9 runs unsandboxed**, like C6 to C8: it runs the reviewed base's `app.setup` and `app.cli.command` with your user's permissions and the allowlisted environment. Only verification runs the command in the sandbox with no network.
41. **One kind per feature.** A feature's scenarios are all `api` or all `cli`; a mixed set, or a spec with both an HTTP and a CLI contract, is `unverifiable` and refuses a new `factory run`.
42. **No UI.** `ui` scenarios are still refused (Phase 1b); a CLI whose spec has no CLI contract gets none.
43. **Fix-brief family words are in memory only.** The failed family (`exit`, `stdout`, `stderr`, `file`, `run`, `setup`) comes from the verification this driver process ran; after a restart the brief has the generic line.
44. **The refusal is for new runs.** An unverifiable feature refuses `factory run` at start; resuming a run (`--continue`) does not re-check it, so such a feature is held at verification as before.
45. **Sandbox IPC residual.** The profile denies POSIX shm, POSIX semaphores and SysV IPC (a sandboxed program could otherwise leave data in shared memory for an outside process). `com.apple.system.notification_center` stays allowed because libSystem needs it, so a sandboxed program can still post darwin notifications an outside same-user process could observe: a low-bandwidth channel, unverified beyond that (needs user step).
