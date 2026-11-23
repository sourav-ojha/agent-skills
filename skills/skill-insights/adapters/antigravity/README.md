# Antigravity CLI (agy)

Install: `npx skills add sourav-ojha/agent-skills --skill skill-insights -a antigravity` (add `-g` for all projects).

Run: `node <skill-dir>/core/scripts/si.mjs report --host antigravity --since 2026-11-01`. Every command takes `--host antigravity`
(`inventory`, `report`, `runs`). `export` and `runs-factory` stay Claude Code only.

## Where the data is

Conversations are SQLite files: `~/.gemini/antigravity-cli/conversations/<conversation-id>.db` (override with `--projects-dir`).
Each file holds protobuf blobs in a `steps` table. agy publishes no schema, so `core/scripts/lib/agy.mjs` reads the field numbers
that were observed in real conversations (listed in its header). Reading is read-only and needs Node.js 22.5+ (`node:sqlite`).
The project shown is the conversation's workspace, from `cache/conversation_metadata.json`.
Installed skills: `~/.gemini/antigravity/skills` and `~/.agents/skills` (add others with `--skills-dir`).

## How it maps

- agy has no `Skill` tool. A skill run is the first read (`read_file` or `view_file`) of `.../skills/<name>/SKILL.md`. Reading the
  same skill's `SKILL.md` again is counted as a repeated read. Other files under that skill folder count as skill-file reads.
- Tokens come from the usage on each model-response step: input, output, cache read, cache write.
- A tool error is a step with status 7 or error details.
- Sub-conversations (subagents) are left out of the top-level counts, as Claude Code subagent transcripts are.

## Limits

- The format is undocumented and may change between agy versions: if numbers look wrong after an upgrade, check `agy.mjs` first.
- A session that reads many `SKILL.md` files in a row to survey them is shown on its own "opened but not worked in" line, not as runs.
- Shell edits are recognised by pattern (redirects, `sed -i`, `tee`, `git checkout` and similar); an unusual command that writes files can still make a re-read look repeated.
- Whether agy's input token count includes cached tokens is not documented; compare input and cache-read per run rather than summing them.
