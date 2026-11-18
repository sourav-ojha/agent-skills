# Reading the numbers

| Metric | Means | If bad, consider |
|---|---|---|
| Avg in / out | fresh tokens per run (input excludes cache) | trim `SKILL.md`; move rarely used text to references; shorter outputs |
| Avg cache-read | context re-read each turn; grows with run length and large results | fewer turns, smaller tool outputs, split phases so context resets |
| Total min | wall time with idle gaps removed | fewer round trips, batch tool calls, parallel where files are disjoint |
| Tool errors | failed tool calls in the skill window | wrong paths or commands in instructions; add the exact command; check helper location |
| Repeated reads | same skill file read twice in a run | inline the 3 lines that matter; reference less |
| Largest result | biggest single tool output | redirect output to a file and read the tail; add a `--summary` flag to helpers |
| Never used | installed, zero invocations in range | delete, merge, or keep only if seasonal |

Heuristics, not verdicts. Small samples (under 3 runs) show direction only. Always compare against the same skill before and after a change.
Standalone vs combined: filter `runs` by skill and compare sessions where other skills ran earlier in the same session.

## Transcript layout and factory runs

The agent host keeps transcripts in a per-project folder (see adapters for its location), where the folder is the project's real path with every non-alphanumeric character replaced by `-`.
- Main sessions are `<project-folder>/<session-id>.jsonl`.
- Subagent transcripts are NOT siblings: they live in `<project-folder>/<session-id>/subagents/agent-<id>.jsonl`, next to `agent-<id>.meta.json` (and sometimes `.prefix.json`). They use the same line shape as a main session (`type`, `timestamp`, `message.usage`, `isSidechain: true`), and their usage is not repeated in the parent file, so they must be added to get true cost.
- `si.mjs` reads these only for `runs-factory` (`loadSessions(dir, { subagents: true })`), tagging each with the parent project hash. `runs`, `report` and `inventory` still count main sessions only. Only the `.jsonl` files are read; metadata files are ignored.

`runs-factory [--dir PROJECT] [--out FILE]` reads `<PROJECT>/.skill-runs/factory-runs.jsonl` (latest record per run and feature) and adds `tokens_in`, `tokens_out`, `cache_create`, `cache_read`, `turns` and `status` to each. A turn belongs to a record when it is in the same project (the hash of the real path, symlinks resolved) and inside `[ts_start, ts_end]`. A turn inside two records' windows is counted for both; both get `status: ambiguous`, plus `ambiguous_turns` and `ambiguous_tokens` (the shared share). Ambiguous rows must not be summed: shared tokens appear in each. The footer reports attribution per run: the run window is [earliest `ts_start`, latest `ts_end`] of that run's records; coverage is the tokens (and, secondarily, turns) inside the run window that also fall inside at least one feature window, divided by all tokens (turns) inside the run window, each turn counted once (aim for 90% or more). Turns outside the run window are ignored. Work done in other worktrees or checkouts is stored under a different project folder and is not joined.
