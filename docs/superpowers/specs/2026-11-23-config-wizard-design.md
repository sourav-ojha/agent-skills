# Config wizard: `deliver config init | edit | explain | set`

Status: draft for approval. Nothing is built until this is approved. Written against `main` + PR 23.

## Intent
`.product/delivery.json` has about 40 keys, each with its own type, range and cross-rules. Today a person gets a template (`deliver config --write`) and a read-only view (`deliver config`), and learns the allowed values by reading `references/config.md` or by hitting a parser error. This design adds a guided way to create and change the file, driven by one schema that also feeds validation, help and docs, so the three can no longer drift.

A person, or an AI agent working for them, must be able to answer "what can I put here, and what does it do?" for any key from the terminal, and to change it without hand-editing JSON.

## Goals
- `deliver config init`: create the file from an optional AI-written draft, then walk the keys.
- `deliver config edit [key|group]`: change values; every prompt shows the current value, the allowed values and a one-line description of each.
- `deliver config explain <key>`: type, allowed values, default, what it does, why it matters, and which factory rule reads it.
- `deliver config set <key> <value>` / `unset <key>`: the same validation without prompts, for agents. Sensitive keys need a person (below).
- One schema is the source of truth for prompts, `explain`, the key list and the generated docs table.
- Zero dependencies (Node `readline`), same as the rest of the repo.

## Non-goals
- The wizard does not read the repository. Finding the test command, port or CI job names is the AI's job (it writes a draft); the wizard validates and lets a person confirm. A deterministic detector is a later, separate decision.
- It never commits, pushes or edits anything but the config file. The file must still be committed and identical to `origin/<base>` before a run (existing rule, unchanged).
- It does not rewrite `parseConfig`. See "Decision D1".
- No colour, TUI library or mouse support.

## What exists today (verified)
- `core/scripts/lib/config.mjs` (226 lines): `parseConfig(raw)` hand-validates every key, rejects unknown keys, returns `{config, errors}`. This stays the authority on what is valid.
- `core/scripts/lib/localconfig.mjs`: `parseLocalConfig` for `~/.factory/config.json` (6 keys, same pattern). `wait_for_reset: true` is refused until the usage-limit classifier is real.
- `deliver.mjs` `C.config`: `--write` copies `templates/delivery.json`; no flag shows the effective config and errors.
- `deliver retry` already refuses without a TTY, which is the precedent for "a person must do this".
- `references/config.md` is the hand-written reference table; `templates/delivery.json` is the example.

## Design

### Schema module
New `core/scripts/lib/configschema.mjs`: one entry per key path.

```
{ path: 'autonomy.level', file: 'project', group: 'merge',
  type: 'enum', values: [{ v: 'L0', d: 'PRs only; nothing is merged' }, { v: 'L1', d: 'squash-merge when CI is green' }],
  default: 'L0', nullable: false, sensitive: true,
  what: 'How far the orchestrator may go without a person.',
  why: 'L1 merges to your base branch on its own.',
  readBy: ['deliver init', 'factory run'], factory: 'must be L0 or L1; merging needs L1' }
```

Types: `enum`, `bool`, `int` (min, max), `text` (maxLen), `argv` (argument list, never a shell string), `list` (of text or glob), `url` (local only), `relpath`, `regex`, and `object` for groups. Each entry carries: `default`, `nullable`, `sensitive`, `what`, `why`, `readBy`, optional `factory` note, and optional `requires` (cross-rule text plus a function over the whole candidate document).

Every key in `parseConfig`'s allowed-key lists has exactly one entry; the local config keys get entries with `file: 'local'`.

### Decision D1: validate by running the parser, do not rebuild it
The wizard never re-implements a rule. To check an answer it builds the candidate document, calls `parseConfig` (or `parseLocalConfig`), and keeps only the errors whose path starts with the key being edited, plus cross-key errors. The schema supplies what to *show* (allowed values, ranges, descriptions); the parser stays what *decides*.
To stop the two drifting, a parity test checks, for every schema entry: the key is accepted by the parser; every listed enum value is accepted; the minimum and maximum are accepted and one past each is rejected; a value of the wrong type is rejected; the set of keys equals the parser's allowed-key lists. A later change that only touches one side fails the build.
Refinement made while planning: the wizard keeps the errors that the change *introduced* (errors on the candidate that the current file does not already have) rather than filtering by key prefix. It covers cross-key errors without a path rule, and it lets a change to a valid key succeed in a file that has unrelated errors.
Cost if wrong: a second place to update for each new key, caught by the test instead of by a user.
Revisit generating the parser from the schema only after this has shipped and the parity test has stayed green through a few key additions.

### Commands (all take `--dir D`; add `--local` for `~/.factory/config.json`)

| Command | Behaviour |
|---|---|
| `config` | Unchanged: show effective config and errors. |
| `config --write` | Unchanged: copy the template. |
| `config init [--from-draft F]` | Refuse if the file exists. Load `F` (JSON) as starting values if given, else the defaults; validate; walk the groups; show a diff against an empty file; confirm; write. |
| `config edit [key\|group] [--profile basic\|factory]` | Walk all keys, one group, or one key. `--profile factory` limits the walk to the keys `factory run` requires and ends with the factory checklist. |
| `config explain <key>` | Print the schema entry in plain text. `config explain --list` lists all keys by group with their one-line `what`. |
| `config set <key> <json-value>` / `unset <key>` | Validate and write one key. Prompts nothing. Sensitive keys: see below. |

`init` and `edit` require a TTY and refuse without one, naming `set` as the scripted path. `explain` and `set` work without one (except sensitive `set`).

### Interaction (one key)
```
autonomy.level   (current: L0, default: L0)   SENSITIVE
  How far the orchestrator may go without a person.
    1) L0   PRs only; nothing is merged
    2) L1   squash-merge when CI is green
  Enter keep   1-2 choose   ? more   - unset   s skip group   q quit without saving
>
```
- Enum, bool: numbered choice. Int: shows the range; out-of-range is rejected on the spot with the parser's own message. List and argv: shows the current items; add, remove, replace. Free text: shows the length limit.
- `?` prints the schema's `why`, `readBy` and `factory` lines.
- `-` sets a nullable key back to null/absent. Keys with `requires` are walked together (see below).
- The walk order follows `group`: `repo` (github, base, branch_prefix, features_dir), `merge` (autonomy, merge, protected_branches, hold_paths), `ci` (checks, local_checks, limits), `app` (app.*), `tests` (tests.*, verification.test_globs), `budgets`, `verification`, `readiness`, `notes`.
- The core is a pure function `step(state, answer) -> state` so tests drive it with scripted answers; the TTY layer only reads lines and prints.

### Cross-key rules the wizard owns
- `autonomy.level` and `merge.mode` are two spellings of one setting; the wizard writes only `autonomy.level` and removes `merge.mode`, so they cannot disagree.
- `app.ready` is exactly one of `url` or `log_pattern`; choosing one clears the other. A `url` must share `app.base_url`'s port; the wizard offers it as the default.
- `app.base_url` is asked as a port number (default shown from the draft or empty) and written as `http://127.0.0.1:<port>`; `localhost` is accepted if typed.
- `verification.required: true` pulls the factory keys into the same walk (`app.start`, `app.base_url`, `app.ready`, `readiness.min_level: 4`, `local_checks: []`).

### Sensitive keys
A key is `sensitive` when changing it can widen what runs unattended or weaken a gate: `autonomy.level` to L1, `merge.mode` squash, `merge.allow_tier3`, `checks.allow_without_ci`, removing entries from `protected_branches` or `hold_paths`, `local_checks` (runs as the user, outside the sandbox), `verification.required` false, `verification.scenario_approval` auto, and raising `budgets`.
- In `edit`/`init`: a changed sensitive key prints one line saying what is now allowed and requires typing `yes`.
- `set`/`unset` on a sensitive key refuse without a TTY (an agent cannot loosen a gate; a person runs `edit`). Tightening (for example L1 to L0) is not sensitive and works from `set`.
- The summary diff marks sensitive changes.

### Writing
Show a diff of the JSON, ask once, then write atomically (temp file in the same folder, then rename), 2-space indent, trailing newline. Refuse a symlinked target or folder. Re-parse the result before reporting success. Print the next step: commit the file and merge it to the base branch.
If the existing file is not valid JSON or fails `parseConfig`, `edit` prints the errors and walks only the failing keys first.

### Factory checklist
`edit --profile factory` ends with a list of what the file alone can prove about `factory run`'s start refusals (verification, readiness level, `local_checks`, `checks.required` not naming `factory/verified`, `github.host`, app block present, `merge.mode` for merging). Items it cannot prove from the file (branch protection requiring `factory/verified`, a stored level-4 readiness result, approved scenarios) are listed as "check outside this file" with the command to run. It does not duplicate the driver's checks; it reuses the same predicates where exported.

### Docs and the template
`references/config.md`'s per-key tables are generated between marker comments from the schema (`node ... config explain --docs`); a test fails if the committed text differs. `templates/delivery.json` stays hand-written; a test requires it to parse with no errors.

### The shared helper for other configs
Prompt loop, diff, atomic write and the sensitive-confirm live in `lib/wizard.mjs`, written to take a schema and a parse function with no delivery-specific imports. Skills must install alone, so a second skill gets a byte-identical copy, enforced by a test (the pattern `runlog.mjs` already uses). The wizard is applied to another config only after an audit shows it is worth it; `product-intelligence` has `config.schema.json` and `config.default.json` and is the first candidate to check. Configs with a handful of keys do not get a wizard.

## Milestones

| | Deliverable | Exit |
|---|---|---|
| C0 | `configschema.mjs`, parity test, `config explain` and `--list`, generated `references/config.md` tables | every parser key has an entry; parity test passes and fails when a key is added to one side only; `explain` output reviewed against the current docs |
| C1 | `set`/`unset`, then `init`/`edit` with `step()` core, diff, atomic write, sensitive confirm, TTY refusal | scripted-answer tests cover each type, each cross-key rule and each sensitive key; an invalid answer never reaches disk; no write on `q` |
| C2 | `--profile factory` and checklist; `--local` for `~/.factory/config.json` (shows `wait_for_reset` as unavailable with the reason) | checklist matches `factory run`'s refusal list for a table of sample files |
| C3 | `wizard.mjs` extraction, copy-and-compare test, audit of other configs | audit written; a wizard added elsewhere only where it pays |

C0 is useful on its own (`explain` alone answers "what values exist"). Each milestone ships behind a normal PR with `npm run check`.

## Risks and rulings
- Ruling: parser stays the authority (D1). If wrong: a drift bug the parity test should catch; the fix is a schema edit.
- Ruling: `set` cannot loosen a gate. If wrong: agents need one extra human step for a sensitive key; that is the intended cost.
- Ruling: no repo detection in the wizard. If wrong: the AI draft step carries all the evidence work; the earlier prompt plus `--from-draft` covers it.
- Risk: the schema text (`what`, `why`) goes stale. Mitigation: generated docs plus the parity test cover values; text is reviewed in PRs like any docs.
- Risk: readline prompts are awkward for long argv lists. Mitigation: argv and lists accept one JSON line as an alternative to item-by-item edits.

## Out of scope
Priority ordering in the queue (separate, planned later); generating `parseConfig` from the schema; auto-detecting test commands, ports or CI job names; a web or TUI front end; changing any factory refusal rule.
