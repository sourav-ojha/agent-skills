# Factory driver: sessions

How the factory driver starts its LLM roles. Code: `core/scripts/lib/sessions.mjs`. Settings: `core/settings/builder.json`, `core/settings/author.json`. Author prompt: `core/prompts/scenario-author.md`.

## Running a session

`runSession({ role, cwd, prompt, settingsFile, configDir?, maxTurns, timeoutS, model? })` runs:

```
claude -p <prompt> --output-format stream-json --verbose --max-turns N --settings <file> \
  --setting-sources user --strict-mcp-config --permission-prompts none [--model M]
# author only: --tools "" --no-session-persistence
```

- Argv only, never a shell. stdin is `/dev/null`. The process gets its own process group, registered with the proc cleanup registry (killed when the driver exits or gets SIGINT/SIGTERM/SIGHUP).
- Timeout: measured with `process.hrtime` (monotonic; on macOS it does not advance while the machine sleeps). On timeout: SIGTERM to the group, SIGKILL after a grace period.
- The stream is parsed line by line. Lines longer than the cap (`maxLineChars`, 8 Mi UTF-16 chars) are dropped and `truncated: true` is set; memory stays bounded. The last `result` event wins.
- Returns `{ ok, sessionId, result, usage: {in, out, cache_create, cache_read}, turns, costUsd, failure, timedOut, truncated, exitCode, signal }`. It never throws for a failed session, only for bad arguments. `costUsd` is Claude Code's list-price estimate, not billed spend.
- `failure.kind`, in this order of precedence:
  - `timeout`, `spawn_failed`, `settings_unsafe`, `unsafe_binary`;
  - `max_turns` (`subtype: error_max_turns`, even with `is_error: true`);
  - a result with another error subtype is classified on its own text, and an earlier rejected rate event does not override it;
  - otherwise `session`, `weekly`, `model`, `rate` or `other` from `classifyFailure` on an `is_error` result or a `rejected` rate event;
  - `no_result` (no `result` event).

  The max-turns result shape is unverified. A usage limit leaves all state as it is; Phase 2 adds waiting and resuming.
- `ok` needs a `result` event with `subtype: "success"`, `is_error: false` and exit code 0. Observed: an auth failure reports `subtype: "success"` with `is_error: true`, so `subtype` alone is not enough.
- Nothing from the stream or stderr is logged. Callers print counts, ids and status only. The author's `result` text holds the scenarios; the caller stores it under `FACTORY_HOME` and never prints it.
- Before spawning, the user settings file that `--setting-sources user` loads (`settings.json` in `CLAUDE_CONFIG_DIR`, else in the home Claude Code config dir) is linted. The session is refused, without spawning, as `failure: { kind: 'settings_unsafe', keys: [...] }` when that file has any of:
  - `hooks`, `statusLine`, `apiKeyHelper` or the aws/otel helpers;
  - `env` keys outside `DISABLE_*`, `CLAUDE_CODE_DISABLE_*`, `BASH_*_TIMEOUT_MS` and `MAX_THINKING_TOKENS`;
  - `permissions.allow`, `permissions.additionalDirectories`, or bypass mode;
  - sandbox widenings: `excludedCommands`, `enableWeakerNestedSandbox`, `allowUnsandboxedCommands`, network `allowedDomains`/`allowUnixSockets`/`allowAllUnixSockets`/proxy ports, filesystem `allowWrite`/`allowRead`;
  - content that cannot be parsed.

  `keys` names keys only, never values. A user settings file with hooks or a status line, which is common, must be cleaned (or the hooks proven inert, gap 15) before the factory can run.
- The binary is resolved to an absolute path once. `PATH` keeps absolute entries only. A `claude` inside the session's cwd is refused (`unsafe_binary`); a missing one is `spawn_failed` (also reported only when no process was created).
- `tmpDir` (optional) becomes the session's `TMPDIR`. Task 11 passes a private dir under the run temp.
- Arguments that look like options are refused: a prompt starting with `-`, a model name outside `[A-Za-z0-9._:[\]-]`, a settings path that is relative, a symlink, not JSON, or fails `checkSettings` (for example still holding `{{...}}` placeholders).

### Environment

Only `PATH`, `HOME`, `LANG`, `TMPDIR`, `USER`, `LOGNAME` and `SHELL` reach claude, plus `CLAUDE_CONFIG_DIR` when the caller passes `configDir` (author only). Tokens such as `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_*`, `NPM_TOKEN` and `ANTHROPIC_API_KEY` are never passed.

Measured on macOS with Claude Code 2.1.325: subscription auth is in the login keychain. With only `PATH`, `HOME`, `LANG` and `TMPDIR`, `claude -p` answered "Not logged in". Adding `USER`, `LOGNAME` and `SHELL` made it work. Which of `USER` and `LOGNAME` is needed was not isolated.

### Settings files

`materialiseSettings(role, { factoryHome, repoDir })` writes a per-run copy under `FACTORY_HOME/run/settings/` (mode 0600). It replaces `{{FACTORY_HOME}}`, `{{HOME}}`, `{{REPO}}`, `{{CLAUDE_DIR}}` (the home Claude Code config dir), `{{GITDIR}}` and `{{GIT_COMMON}}` with absolute paths. The last two are the repo's git dir and common dir; for a linked worktree they are resolved through the `.git` file, whose pointer file is then denied too. A symlinked or malformed `.git` throws. Like the others, these get, and adds the realpath form when it differs. Unknown placeholders, relative paths and paths with glob or rule characters throw. In `Read(...)` and `Edit(...)` rules, `//` starts an absolute path, so a template rule `Read(/{{FACTORY_HOME}}/**)` becomes `Read(//Users/.../.factory/**)`.

Builder (candidate A of `docs/factory/spikes/sandbox-deny.md`):
- `permissions.defaultMode: acceptEdits`, `disableBypassPermissionsMode: disable`, `blockWritesOutsideWorkingDirectories: true`, no `allow` and no `ask` rules.
- Deny `Read`/`Edit`/`Write` of `FACTORY_HOME`.
- Deny `Read` (rule AND sandbox `denyRead`, in both `~/` and absolute forms) of:
  - credential stores: `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`, `~/.docker/config.json`, `~/.claude.json`, `~/.git-credentials` and `~/.netrc`;
  - in `~/.claude*`: `.credentials.json`, `projects`, `todos`, `file-history`, `sessions`, `session-env`, `shell-snapshots`, `paste-cache`, `tasks`, `backups` and `history.jsonl`.

  `checkSettings` fails when any `Read(...)` path deny lacks a sandbox `denyRead` twin.

  The whole `~/.claude` is NOT read-denied: the builder must read the implementer skill (skills and plugins live in the home Claude Code config dir) with the Read tool and run its helper with `node` from Bash. A permission `allow` cannot re-open a deny, so a whole-dir deny would disable the builder.
- Deny `Edit` of `~/.claude*` and `~/.claude.json` (a builder that wrote user settings would change later sessions, because `--setting-sources user` loads them).
- `.git`: deny `Edit` (and sandbox `denyWrite` for the gitdir and common dir) of `config`, `hooks`, `info`, `modules`, `commondir`, `config.worktree`, `objects/info` (alternates) and `worktrees`, at any depth. Deny `Edit` of any `.git` below the repo's top level. Deny `Write(**/.git/**)`, `Write(**/.git)` and `NotebookEdit(**/.git/**)`. The sandbox `denyWrite` covers the same top-level `.git` parts.
- Deny `Bash` for `gh`, `git push` (also `git <opt> push` and `git <opt> push <args>`), `*factory.mjs*` and `*deliver.mjs*`. Deny `WebFetch` and `WebSearch`.
- `disableAllHooks: true`, `enableAllProjectMcpServers: false`. No MCP servers: `--strict-mcp-config` with no `--mcp-config`.
- Sandbox: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, no `excludedCommands`, no allowed network domains (`allowLocalBinding` for tests that open a port). `denyRead`: the twin of every Read rule. `denyWrite`: `FACTORY_HOME`, the home Claude Code config, `~/.claude.json`, the git parts above, and nested `.git`.

The top-level `.git` stays writable by Bash on purpose, because the builder must `git commit` (the driver never commits in builder worktrees). Claude Code merges `Edit(...)` deny rules into the sandbox `denyWrite` (the 2.1.325 schema says so). A rule like `Edit(**/.git/**)` would therefore stop every commit. A test enforces this.

Author: every built-in tool denied (`Bash`, `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`, `Task`), plus `--tools ""` in argv. Hooks are off, there is no network, and nothing is persisted (`--no-session-persistence`, so the scenarios never land in a transcript the builder could read).

`checkSettings` is an ALLOWLIST of keys: top level `permissions`, `disableAllHooks`, `enableAllProjectMcpServers`, `sandbox`, `$schema`, and named sub-keys only. It refuses:
- any other key (hooks, `env`, `apiKeyHelper`, `statusLine`, plugins, `additionalDirectories`, `allowWrite`, unix sockets, `enableWeakerNestedSandbox`, ...);
- a Read deny without a sandbox `denyRead` twin;
- an `allow` rule that widens a deny (in the file-path families, any `allow` next to a deny);
- `ask` rules and bypass mode;
- a disabled sandbox, an unsandboxed escape, `excludedCommands` or allowed network domains;
- leftover placeholders.

## Known gaps

Everything below is **unverified (needs user step)**, unless it says "measured". The steps are in `docs/factory/spikes/sandbox-deny.md`.

1. **Deny rules are not proven to block.** The keys used all appear in the 2.1.325 binary, and the settings file was accepted by a real `claude -p` run (measured). Whether each rule blocks each route (Read, Grep, Glob, WebFetch `file://`, subagents, Bash children) is unverified (needs user steps 2-5).
2. **Rule path syntax.** That `//abs` in `Read(...)` and `Edit(...)` is absolute, and that `~/.claude*/...` globs match `~/.claude-<x>/`, comes from the docs and is unverified (needs user step 3; `claude doctor` shows dropped rules).
3. **Sandbox path syntax and globs.** `sandbox.filesystem` entries use plain absolute paths. The schema says "absolute paths and ~ expansion". Whether globs merged from `Edit(**/.git/...)` rules are enforced by the macOS sandbox is unverified (needs user step 7).
4. **`Write(...)` and `NotebookEdit(...)` path rules.** The docs say `Edit(...)` rules cover all file-editing tools. The extra `Write`/`NotebookEdit` rules are belt and braces. If Claude Code maps them into the sandbox `denyWrite`, `Write(**/.git/**)` would block `git commit`. That would show at once as a failed build (fail closed). Unverified (needs user step 7).
5. **Nested `.git` at any depth via Bash.** The sandbox `denyWrite` names only the top-level `.git` parts. Nested `.git` writes rely on the merged `Edit(/<repo>/*/**/.git...)` globs (gap 3). The driver's gitSafe preflight (Task 6) is the authority.
6. **Textual Bash rules.** `Bash(gh *)` and friends match command text. A wrapper script or `env gh` bypasses them. The real barriers are no network domains, no `GH_TOKEN` in the environment, and the `~/.config/gh` read deny. Unverified (needs user step 7).
7. **`--max-turns`** is not listed in `claude --help` 2.1.325. It was accepted by a real run (measured).
8. **`--permission-prompts none`, `--tools ""` and `--no-session-persistence`** were accepted by a real run (measured). With `--tools ""` the init event listed no tools (measured).
9. **User plugins and skills still load** under `--setting-sources user`: the init event listed them (measured). Their hooks are off (`disableAllHooks`, documented, not tested). `--safe-mode` would drop them, but also drops the implementer skill the builder needs.
10. **`CLAUDE_CONFIG_DIR` and auth.** Whether a separate config dir keeps subscription auth is unverified (needs user step 6). So `configDir` is off by default and only used when the caller passes it. Without it, an author that persisted its session would write a transcript under `~/.claude*/projects`. That is why the author runs with `--no-session-persistence`.
11. **API-key or token auth** (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) is not passed through. Supporting it is an open question.
12. **Orphans if the driver is SIGKILLed.** The cleanup registry covers exit and SIGINT/SIGTERM/SIGHUP (tested). A SIGKILLed driver cannot clean up, so `claude` keeps running in its own group. The driver lock must record the `onSpawn` process group and kill it on the next start (Task 11). Whether `claude -p` exits by itself when its stdout closes is unverified (needs user step 8).
13. **No network for the builder** means it cannot install packages. Dependencies must already be installed in the clone.
14. **`permissions.blockReadsOutsideWorkingDirectories` is not set.** The builder must read the implementer skill from outside the repo. `FACTORY_HOME` and transcripts are denied by name instead.
15. **User settings precedence.** Whether our `--settings` `disableAllHooks: true` overrides hooks and a status line from user settings is unverified (needs user step 5). Until then such a user file refuses the session (`settings_unsafe`).
16. **Remaining readable secrets.** The read denies list known credential stores only. Other secrets stay readable to the builder: `.env` files in other repos, browser profiles, `~/Library`, tool-specific token files not listed, and the keychain via `security`, which the sandbox may or may not block. A builder could commit such a value into the feature branch. A pre-push secret scan of the branch diff is the driver's job (Task 11).
17. **Git redirections, driver side.** Writes to `commondir`, `config.worktree`, `objects/info/alternates` and `worktrees` are denied to the builder; the denies are unverified (gap 3). gitSafe's worktree preflight now refuses a repo with `objects/info/alternates` or `config.worktree` (tested). A planted `commondir` in a plain clone, and `mv` of a whole repo into place, are not checked by gitSafe. Carry to Task 11: refuse a clone whose `git rev-parse --git-common-dir` is not `<clone>/.git`.
18. **The max-turns result shape** (`subtype: error_max_turns`, with or without `is_error`) is from docs and assumptions, not a capture.

## Carry to Task 11

- **Process groups.** Processes the builder's Bash tool starts with `setsid` or their own group leave the session's group, so neither the timeout kill nor the cleanup registry reaches them. The driver should check for leftovers (for example by cwd, or listeners on the app port) before verification.
- **Builder cwd.** Whether the builder runs in the factory clone (`.git` dir) or a linked worktree (`.git` file). Both are handled by `materialiseSettings`, but the choice changes which dirs are denied. Decide and test it.
- **Moving `.git`.** Whether `mv` of `.git` or of a repo into place is blocked by the sandbox is unverified.
- **`--fix-brief`.** The brief file must be inside the clone (for example `.implementation/<ID>/fix-brief.md`), because the builder cannot read `FACTORY_HOME`.
- **Author cwd.** The author runs in an empty directory under `FACTORY_HOME/run/`.
- **TMPDIR.** Create a private `tmpDir` per session under the run temp and pass it.
- **Secret scan.** Run a pre-push secret scan of the branch diff (gap 16).
- **Commondir check.** gitSafe check for the clone's common dir (gap 17).

