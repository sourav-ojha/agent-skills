# Config Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `deliver config init | edit | explain | set | unset` (project file and, with `--local`, `~/.factory/config.json`), driven by one schema that also generates the key tables in `references/config.md`.

**Architecture:** A schema module describes every key (type, allowed values, default, description, sensitivity). `parseConfig` / `parseLocalConfig` stay the only authority on validity; the wizard validates a change by running the parser on the candidate document and keeping the errors the change introduced. A generic prompt loop (`lib/wizard.mjs`, no delivery imports) is driven by the schema; `lib/configcmd.mjs` holds the command logic; `deliver.mjs` only dispatches.

**Tech Stack:** Node >=22 ESM, zero dependencies, `node:test`, `node:readline`.

**Spec:** `docs/superpowers/specs/2026-11-23-config-wizard-design.md`

## Global Constraints

- Zero dependencies; Node `readline` only; no colour or TUI code.
- All new code is under `skills/delivery-orchestrator/core/scripts/` (`lib/configschema.mjs`, `lib/configedit.mjs`, `lib/wizard.mjs`, `lib/configcmd.mjs`, `lib/factorycheck.mjs`); tests are `tests/validation/config-wizard-*.test.mjs`.
- The rules in `parseConfig` and `parseLocalConfig` are not rewritten. The only edit to `lib/localconfig.mjs` is `export const KEYS`.
- The commands never run git, never stage or commit, and touch only the config file.
- Writes are atomic (temp file in the same folder, then rename), 2-space JSON with a trailing newline, refuse a symlinked file or folder, and refuse if the file changed on disk since it was read.
- `init` and `edit` require a TTY on stdin and stdout; without one they exit 1 and name `set`. `set`/`unset` on a sensitive loosening also exit 1 without a TTY.
- Argument lists (`argv` type) are never shell strings. Existing commands (`config`, `config --write`) behave exactly as before.
- Exit codes: 0 done, 1 error (`die`). Non-interactive commands print JSON via the existing `emit`, except `explain` and `explain --list`, which print plain text (`--json` gives JSON).
- Existing CLI parsing: `BOOL` flags in `deliver.mjs` take no value; every other `--flag` takes the next argument; positionals are `pos[]`. New boolean flags: `list`, `docs`, `local`. New value flags: `profile`, `from-draft`.
- The schema's descriptions are plain, one line each, no marketing words.

## Review Focus

Failure modes the tests below must pin (each is added to the task that owns it):
1. `set` with a JSON value of the wrong type (`"5"` for an integer, a string for a list) is rejected with the parser's message and the file is byte-identical afterwards (T3).
2. A mistyped key (`autonomy.levl`) is refused with up to three nearest valid keys, nothing written (T3).
3. The file changes on disk between read and write (another editor, a `git checkout`): the write is refused, not merged (T3).
4. An agent (no TTY) tries to loosen a gate with `set`: refused; tightening the same key works (T3).
5. An existing file that is invalid JSON, a symlink, or has an unknown key: `edit` shows the errors and fixes only the failing keys; `set` on an unrelated valid key still works when the file has other errors (T3, T4).

---

### Task 1: Schema module and parity test

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/configschema.mjs`
- Modify: `skills/delivery-orchestrator/core/scripts/lib/localconfig.mjs` (add `export` to `KEYS`)
- Test: `tests/validation/config-wizard-schema.test.mjs`

**Interfaces:**
- Produces:
  - `SCHEMA: Entry[]`, where `Entry = { path, file: 'project'|'local', group, type, values?: {v, d}[], min?, max?, maxLen?, default, nullable, sensitive, what, why, readBy: string[], factory?: string, alias?: { to, map }, requires?: string }`
  - `type` is one of `enum bool int text argv list url relpath regex local_checks ready`
  - `GROUPS: string[]` in walk order: `repo merge ci app tests budgets verification readiness notes local`
  - `entry(path, file='project')`, `keysOf(file)`, `nearest(path, file, n=3)`, `renderExplain(entry)`, `renderDocs(file)`

- [ ] **Step 1: Write the failing parity tests** in `config-wizard-schema.test.mjs`:
  - `every schema path is accepted by the parser`: for each project entry, build a document with the entry's default (or, for a nullable-null default, its first valid example) and require `parseConfig` errors `[]`; same for local entries via `parseLocalConfig`.
  - `schema keys equal the parser's allowed keys`: for each object path (`''`, `github`, `merge`, `autonomy`, `budgets`, `budgets.feature`, `checks`, `limits`, `app`, `app.ready`, `tests`, `readiness`, `verification`, `verification.session_timeout_s`, `.max_turns`, `.model`), call `parseConfig` with `{<path>: {__nope__: 1}}`, read the `(allowed: a, b)` list out of the error, and require it to equal the set of schema children at that path (`version` and `merge.mode` count as present). For local config, compare `KEYS` to the local entries' top-level names.
  - `enum values and numeric bounds are exact`: for each enum entry every listed value is accepted and `"__bad__"` is rejected; for each `int` entry `min` and `max` are accepted and `min-1`, `max+1` are rejected (use the parser error text to confirm the rejection is on that key).
  - `wrong types are rejected`: for each entry a value of another type (`{}` for scalars, `5` for strings) yields an error on that key.
  - `every entry has what, why, readBy` non-empty, and `what` is one line under 120 characters.
- [ ] **Step 2: Run** `node --test tests/validation/config-wizard-schema.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `configschema.mjs`.** One entry per leaf key the parser accepts, taken from `lib/config.mjs` and `lib/localconfig.mjs` (read them; do not guess bounds). `merge.mode` is an entry with `alias: { to: 'autonomy.level', map: { 'pr-only': 'L0', squash: 'L1' } }` and is not walked. `version` is not an entry. `readiness` is an entry of type `object-null` described as the opt-in switch; its children are `readiness.min_level`, `readiness.max_age_days`. `app.ready` has type `ready` (one of url or log_pattern, plus timeout_s); `local_checks` has type `local_checks`. Mark `sensitive: true` on: `autonomy.level`, `merge.mode`, `merge.allow_tier3`, `checks.allow_without_ci`, `checks.ignored`, `protected_branches`, `hold_paths`, `local_checks`, `verification.required`, `verification.scenario_approval`, `budgets.feature.tokens`, `budgets.feature.turns`, `budgets.day_tokens`. `nearest` uses edit distance over `keysOf(file)`.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): config schema with parser parity test`.

### Task 2: `config explain`, generated docs, CLI dispatch

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/configcmd.mjs`
- Modify: `skills/delivery-orchestrator/core/scripts/deliver.mjs` (BOOL set, HELP text, `C.config` delegates new subcommands), `skills/delivery-orchestrator/references/config.md` (generated blocks)
- Test: `tests/validation/config-wizard-schema.test.mjs` (extend)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `runConfigCommand({ sub, args, opt, root, home, io, tty }) -> Promise<number>` (exit code), where `io = { out(text), err(text), ask(prompt) }`. This task implements `sub` in `explain`; later tasks add the rest.

- [ ] **Step 1: Write failing tests:**
  - `explain autonomy.level` (spawn `deliver.mjs config explain autonomy.level --dir <tmp>`): exit 0; stdout contains `L0`, `L1`, the `what` line, the `default`, and `SENSITIVE`.
  - `explain --list` lists every project key grouped, one line each; `--local` lists the six local keys.
  - `explain app.redy` exits 1 and names `app.ready` (Review Focus 2).
  - `explain --docs` output equals the text between the `<!-- config-schema:project:start -->` and `:end -->` markers in `references/config.md` (the docs-in-sync test), and the same for `local`.
  - `config` with no subcommand and `config --write` still behave as in `delivery-orchestrator.test.mjs` (that file's CFG tests must pass unchanged).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `deliver.mjs` add `list`, `docs`, `local` to `BOOL`; extend the `config` line of `HELP`; in `C.config`, when `arg` is one of `init edit explain set unset`, call `runConfigCommand` with `pos.slice(2)` and set `process.exitCode`. `renderExplain` prints name, current default, type and allowed values with their descriptions, `what`, `why`, `readBy`, the `factory` note, and `SENSITIVE` when set. `renderDocs(file)` emits one markdown table per group (columns: key, meaning, default). In `references/config.md` replace the three hand-written tables (main, readiness keys, verification keys) with generated blocks between the markers, keeping the prose sections; add a block for the local keys under the existing local-config paragraph. Regenerate with `node deliver.mjs config explain --docs`.
- [ ] **Step 4: Run** the new tests and `node --test tests/validation/delivery-orchestrator.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): config explain and generated key reference`.

### Task 3: Editing core, `set` and `unset`

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/configedit.mjs`
- Modify: `lib/configcmd.mjs` (`set`, `unset`)
- Test: `tests/validation/config-wizard-edit.test.mjs`

**Interfaces:**
- Produces in `configedit.mjs`:
  - `readDoc(file) -> { doc, sha, exists }` (throws on invalid JSON, symlink, or non-regular file)
  - `getPath(doc, p)`, `setPath(doc, p, v) -> doc'` and `unsetPath(doc, p) -> doc'` (both pure; `unsetPath` prunes objects left empty)
  - `validateChange(before, after, kind) -> { ok, errors }` where `kind` is `'project'|'local'`; `errors` are those `parseConfig`/`parseLocalConfig` report for `after` and not for `before`
  - `loosens(entry, before, after) -> string|null` (a one-line reason when the change widens what runs unattended)
  - `diffLines(before, after) -> string[]`
  - `writeDoc(file, doc, { sha, mode }) -> void` (atomic; refuses a symlink; refuses when the file's current sha differs from `sha`)
  - `parseValue(text) -> any` (JSON if it parses, otherwise the raw string)
- `loosens` rules: `autonomy.level` to `L1` (or `merge.mode` to `squash`); `merge.allow_tier3` or `checks.allow_without_ci` to `true`; any entry removed from `protected_branches` or `hold_paths`; any entry added to `checks.ignored`; any added or changed `local_checks` item; `verification.required` true to false; `verification.scenario_approval` human to auto; any increase of `budgets.feature.tokens`, `budgets.feature.turns`, `budgets.day_tokens`. Ruling: `checks.ignored` additions count because an ignored check can never hold a feature; if wrong, a person sees one extra `yes`.

- [ ] **Step 1: Write failing tests** (each uses a temp dir with a `.product/delivery.json`, spawning `deliver.mjs config set|unset ... --dir <tmp>` for CLI cases, importing `configedit.mjs` for unit cases):
  - `set base develop` writes `{"base":"develop"}` formatting (2 spaces, trailing newline); `set budgets.feature.tokens 4000000` creates nested objects; output JSON names the key and old and new value.
  - Review Focus 1: `set budgets.feature.tokens '"5"'` and `set checks.required '"x"'` exit 1 with the parser message; file bytes unchanged.
  - Review Focus 2: `set autonomy.levl L0` exits 1 and stderr contains `autonomy.level`.
  - Alias (unit, `setPath`/`configcmd` with an injected TTY flag): setting `merge.mode` to `squash` writes `autonomy.level` `L1` and leaves no `merge.mode` key; `pr-only` writes `L0`.
  - Review Focus 4: without a TTY, `set autonomy.level L1` exits 1 and stderr says a person must run `config edit`; `set autonomy.level L0` on a file holding L1 exits 0. Same pair for `verification.required` and `protected_branches` (removal refused, addition allowed).
  - Review Focus 3 (unit): `writeDoc` with a stale `sha` throws and leaves the file untouched; a symlinked `delivery.json` is refused; a symlinked `.product` folder is refused.
  - Review Focus 5: with a file that already has an unrelated unknown key, `set base develop` still succeeds only if the unknown key was already an error before (the change introduced no new error), and prints the remaining errors as a warning list; a file that is not valid JSON makes `set` exit 1 naming the file.
  - `unset app.ready` removes the key and prunes `app` when empty; `unset` of an absent key exits 0 and says so.
  - Never git: the temp dir has no `.git`, and the commands succeed.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `configedit.mjs` and `set`/`unset` in `configcmd.mjs`.** Key lookup uses `entry()`; unknown keys call `nearest`. `--local` selects `~/.factory/config.json` via `factoryHome()` (mode `0o600`; project file `0o644`). After a write, re-read and re-parse; if the re-parse has new errors, exit 1.
- [ ] **Step 4: Run** `node --test tests/validation/config-wizard-edit.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): config set and unset with sensitive-change guard`.

### Task 4: Prompt loop, `init` and `edit`

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/wizard.mjs`
- Modify: `lib/configcmd.mjs` (`init`, `edit`)
- Test: `tests/validation/config-wizard-edit.test.mjs` (extend)

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces in `wizard.mjs` (no delivery-specific imports; schema and callbacks are injected):
  - `parseAnswer(entry, text, current) -> { action: 'keep'|'set'|'unset'|'help'|'skip-group'|'quit'|'invalid', value?, message? }` (pure)
  - `walk({ entries, doc, io, validateChange, loosens, only }) -> Promise<{ doc, changed: string[], quit: boolean }>`
  - `renderPrompt(entry, current) -> string` in the format shown in the design

- [ ] **Step 1: Write failing tests:**
  - `parseAnswer`: empty line keeps; `2` on a two-value enum chooses the second value; `9` is invalid with a range message; `-` unsets only when `nullable`; `?` is help; `s` skip-group; `q` quit; an `int` entry rejects `abc` and out-of-range numbers with the bounds in the message; `list`/`argv` accept a JSON array on one line; `text` over `maxLen` is invalid.
  - `walk` with scripted answers (an `io` object whose `ask` pops from an array): keep-all produces `changed: []` and an identical doc; changing `autonomy.level` to L1 with answers `2`, then `no` to the `yes` confirm leaves L0; answering `yes` applies it; `q` returns `quit: true` and the caller writes nothing; an answer rejected by `validateChange` re-asks the same key.
  - Cross-key rules: choosing `app.ready` `url` clears `log_pattern` and offers the `base_url` port; setting `app.base_url` by port number `4000` stores `http://127.0.0.1:4000`; answering `autonomy.level` removes any `merge.mode`; setting `verification.required` to true adds the factory keys to the walk.
  - `init` via `runConfigCommand` with injected `io`: refuses when the file exists; with `--from-draft` a JSON file, starts from its values; a draft with an invalid value shows the error and walks that key first; the confirm step shows the diff and answering `n` writes nothing.
  - `edit autonomy.level` walks only that key; `edit repo` walks only the `repo` group; `edit` on an invalid existing file walks the failing keys first (Review Focus 5).
  - Spawned without a TTY, `init` and `edit` exit 1 and stderr mentions `config set`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `walk` visits entries of the chosen scope in `GROUPS` order, skipping `alias` entries and non-nullable-null keys not in scope. Each prompt prints `renderPrompt`; each accepted answer goes through `validateChange`; a sensitive loosening (`loosens` non-null) prints that reason and requires the literal `yes`. `init` and `edit` print `diffLines`, ask once, then `writeDoc`, then print the next step (commit and merge to the base branch). The TTY layer builds `io` from `node:readline` on stdin/stdout.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): config init and edit wizard`.

### Task 5: Factory profile and checklist

**Files:**
- Create: `skills/delivery-orchestrator/core/scripts/lib/factorycheck.mjs`
- Modify: `lib/configcmd.mjs` (`edit --profile factory`)
- Test: `tests/validation/config-wizard-factory.test.mjs`

**Interfaces:**
- Produces: `fileProblems(policy) -> { id, why, fix }[]` for the checks `startChecks` makes from the file alone (verification required, readiness level 4, `local_checks` empty, `checks.required` not naming `factory/verified`; not the `github.host` check, which needs the git remote) plus the app block (`app.start`, `app.base_url` with a port, `app.ready` on that port) and `merge.mode` for merging; `outsideFile() -> { what, command }[]` for the items the file cannot prove (branch protection, stored level-4 result, approved scenarios). The `why` text for shared checks equals the text in `startChecks` (`lib/../factory.mjs`) so one wording exists.

- [ ] **Step 1: Write failing tests:**
  - A table of sample policies (parsed through `parseConfig`) with the expected `id`s: empty config gives verification, readiness, app block; a complete factory config gives none; `local_checks` present gives one; `checks.required: ['factory/verified']` gives one.
  - Agreement with the driver: for each sample, the `why` strings equal those `startChecks` produces for the same policy (reuse how `tests/validation/factory-driver.test.mjs` builds a `ctx`; stub `gh` and the readiness file so only file-derived checks differ).
  - `edit --profile factory` with scripted answers walks only the factory keys and ends by printing the checklist, with the three "check outside this file" lines and their commands (`deliver readiness`, `factory scenarios`, branch protection).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Do not change `startChecks`; the agreement test is what keeps the wording shared.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): factory profile and checklist for config edit`.

### Task 6: Local config

**Files:**
- Modify: `lib/configcmd.mjs`, `lib/configschema.mjs` (the local entries already exist from Task 1)
- Test: `tests/validation/config-wizard-factory.test.mjs` (extend)

- [ ] **Step 1: Write failing tests** (a temp `FACTORY_HOME`):
  - `config set --local max_wait_h 3` writes `<FACTORY_HOME>/config.json` with mode `0600`; `set --local wait_for_reset true` exits 1 with the parser's "classifier is fixtures only" message and writes nothing; `explain --local wait_for_reset` states it is unavailable and why.
  - `set --local budgets.day_tokens 20000000` works; it is sensitive when raised, so it refuses without a TTY and succeeds when lowered.
  - `edit --local` with scripted answers walks only the local group and skips `wait_for_reset` as unavailable.
  - A symlinked `config.json` is refused on read and write.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `classifierReal` is `CLASSIFIER_STATUS === 'real'`, as `factory.mjs` computes it.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(delivery-orchestrator): config wizard for the local run-control config`.

### Task 7: Docs, changelog and the audit of other configs

**Files:**
- Modify: `docs/guides/delivery-orchestrator.md`, `skills/delivery-orchestrator/SKILL.md` (one line under the config paragraph), `skills/delivery-orchestrator/references/config.md` (prose: how to use the wizard), `CHANGELOG.md`, `docs/superpowers/specs/2026-11-23-config-wizard-design.md` (status line)
- Create: `docs/superpowers/specs/2026-11-23-config-wizard-audit.md`
- Test: `tests/validation/config-wizard-schema.test.mjs` (extend)

- [ ] **Step 1: Write failing tests:** the guide and `SKILL.md` mention `config explain` and `config edit`; `SKILL.md` stays under 500 lines (the validator already checks this); the CHANGELOG has an `Unreleased` entry naming the five commands.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the docs and CHANGELOG entry.** Bump `metadata.version` in `SKILL.md` per the SemVer-per-skill rule (see how `git show c25f36f -- skills/delivery-orchestrator/SKILL.md` did it). Write the audit: list every config-bearing skill file (start with `skills/product-intelligence/core/schemas/config.schema.json` and `config.default.json`), count keys, and say per config whether a wizard is worth it (a handful of keys: no). If one is worth it, say so and stop: it gets its own plan, with a byte-identical copy of `wizard.mjs` guarded by a test like the `runlog.mjs` one. Do not extract or copy `wizard.mjs` in this plan.
- [ ] **Step 4: Run** `npm run validate` and the config-wizard tests. Expected: 0 errors, PASS.
- [ ] **Step 5: Run the full suite** `npm run check` (about 13 minutes; run in the background). Expected: all pass except the pre-existing `factory-runcontrol-driver` session-limit failure on `main`; report it as pre-existing, do not touch it.
- [ ] **Step 6: Commit** `docs(delivery-orchestrator): config wizard guide, changelog and config audit`.
