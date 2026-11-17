# skill-insights: design (PR 1 of 3)

## Intent
Measure how skills actually perform so they can be improved for **performance, token efficiency, correctness, completeness**, used
standalone or combined. Also answer "which installed skills do I really use" to drive consolidating global skills into this repo.

## Scope of this PR
Read-only analyzer over Claude Code session transcripts (`~/.claude/projects/*/*.jsonl`). No change to other skills. PR 2 adds `pi`/`impl`
event logs, run self-report and `export`; PR 3 adds vendoring and `skills.lock.json`.

## Non-goals
No network, no writes outside stdout (and an optional `--out` file), no prompt or file content in any output, no dependencies.

## Data used (verified in a real transcript)
Per line JSON: `type`, `timestamp`, `message.usage` (input, output, cache_read, cache_creation tokens), `message.content[]` blocks
`tool_use` (`name`, `input`) and `tool_result` (`is_error`, `content`). A skill run is a `tool_use` with `name: "Skill"` and `input.skill`.

## Attribution rule (approximation, stated in output)
A skill's window starts at its `Skill` invocation and ends at the next `Skill` invocation of any skill or the end of the session. Tokens,
wall time, tool calls, tool errors and `Read`s of files under a `/skills/<name>/` path inside the window belong to it. Activity before
any skill is `(none)`. Idle gaps over 10 minutes are excluded from wall time.

## Commands (`node si.mjs ...`)
- `inventory [--projects-dir D] [--skills-dir D ...] [--since YYYY-MM-DD]`: per skill: invocations, sessions, projects, last used; plus
  installed-but-never-used skills found under the given skills dirs.
- `runs [--skill NAME] [--json]`: per invocation window: tokens (in/out/cache), wall time, tool calls/errors, reference files read, repeated
  identical reads, largest tool results (bytes).
- `report [--skill NAME]`: markdown summary of both, **redacted**: projects shown as short hashes, no absolute paths, no message text.

## Acceptance criteria
- AC1 Parsing a transcript yields Skill invocations, per-message token usage, tool errors and skill-file reads; malformed lines are skipped.
- AC2 Tokens, time and errors are attributed to the active skill window; pre-skill activity is `(none)`; idle gaps are excluded.
- AC3 `inventory` counts invocations, sessions and last-used per skill across projects and lists installed-but-unused skills.
- AC4 `report` output contains no home path, project directory name or message text.
- AC5 The CLI runs end to end on a fixture dir, survives a missing dir and corrupt files, and `--since` filters by session date.
- AC6 SKILL.md <= 150 lines, links resolve, `npm run check` passes.

## Approaches considered
1. Transcript analysis only (chosen for PR 1): works on past runs, zero change to skills, shows real cost.
2. Event logs only: exact but needs every skill changed first and has no history. Deferred to PR 2 as a complement.
3. Hosted telemetry: rejected (privacy, dependency).
