# Installation

Product Intelligence is a single self-contained folder (`skills/product-intelligence/`). You can install just that folder; nothing else in this repository is required.

Requirements: Claude Code or Codex (or any Agent Skills host), Node.js 20+ for the bundled helper (`core/scripts/pi.mjs`); the `skills` CLI itself needs Node 22.20+ per its docs, and this repository's own tests and tooling need Node 22+. Web search/fetch access is needed for the research phases.

> Replace `sourav-ojha/agent-skills` below with the repository you publish. Paths below were checked against the official docs and a local install test on 2026-11-16 (see "Verified paths").

## Option 1 — `skills` CLI (cross-agent, installs only this skill)

```bash
# project-level, both agents
npx skills add sourav-ojha/agent-skills --skill product-intelligence -a claude-code -a codex

# personal (all projects)
npx skills add sourav-ojha/agent-skills --skill product-intelligence -a claude-code -a codex -g

# one agent only
npx skills add sourav-ojha/agent-skills --skill product-intelligence -a claude-code
npx skills add sourav-ojha/agent-skills --skill product-intelligence -a codex

# see what a repository offers without installing
npx skills add sourav-ojha/agent-skills --list
```

Add `--copy` to install real copies instead of symlinks to a shared canonical copy (recommended on Windows, or if you want the folder committed to your repo). Add `-y` for non-interactive use.

What it does (verified): the whole skill folder is installed, including `core/`, `references/`, `templates/` and `adapters/`.

| Agent | Project scope | Personal scope (`-g`) |
|---|---|---|
| Claude Code | `.claude/skills/product-intelligence/` | `~/.claude/skills/product-intelligence/` |
| Codex | `.agents/skills/product-intelligence/` | `~/.agents/skills/product-intelligence/` |

## Option 2 — Manual copy

```bash
git clone https://github.com/sourav-ojha/agent-skills.git && cd agent-skills

# Claude Code, personal
mkdir -p ~/.claude/skills && cp -R skills/product-intelligence ~/.claude/skills/
# Claude Code, project
mkdir -p .claude/skills && cp -R /path/to/agent-skills/skills/product-intelligence .claude/skills/

# Codex, personal
mkdir -p ~/.agents/skills && cp -R skills/product-intelligence ~/.agents/skills/
# Codex, project
mkdir -p .agents/skills && cp -R /path/to/agent-skills/skills/product-intelligence .agents/skills/
```

Symlinks work too (Codex documents symlinked skill folders). Claude Code live-reloads skill edits; if a brand-new top-level skills directory was created mid-session, restart the session.

## Option 3 — Release archive

```bash
node scripts/package-skill.mjs product-intelligence   # creates dist/product-intelligence-<version>.zip
unzip dist/product-intelligence-*.zip -d ~/.claude/skills/   # or ~/.agents/skills/
```

## Optional: native sub-agents

The skill works without them (it falls back to generic sub-agents, or to sequential single-agent work). Installing them gives scoped read-only tools and per-role model selection.

```bash
# Claude Code (user-level, or --scope project --project-dir .)
node ~/.claude/skills/product-intelligence/core/scripts/install-agents.mjs --agent claude-code --scope user
# Codex
node ~/.agents/skills/product-intelligence/core/scripts/install-agents.mjs --agent codex --scope user
# Both, project level, from the project root
node .agents/skills/product-intelligence/core/scripts/install-agents.mjs --agent all --scope project --project-dir .
```

Files land in `~/.claude/agents/`, `~/.codex/agents/`, `<project>/.claude/agents/` or `<project>/.codex/agents/` (`pi-*.md` / `pi-*.toml`). Add `--dry-run` to preview. Project-scope installs take the model mapping from `.product/config.json` (see [usage](usage.md#configuration)); user-scope installs ignore the current project's config on purpose and use the defaults. Re-run after changing it.

## Verify the install

Start your agent in a project and run:

- Claude Code: `/product-intelligence` (no argument runs a status check) — or ask "what's the product-intelligence status?"
- Codex: `$product-intelligence` or `/skills` to confirm it is listed.

Or check the helper directly:

```bash
node <skill-dir>/core/scripts/pi.mjs status --dir .
```

## Upgrade

- `skills` CLI: re-run the same `npx skills add … --skill product-intelligence …` command to fetch the latest (run `npx skills --help` for the update/check subcommands in your CLI version). The lock file `skills-lock.json` records the source and hash.
- Manual: delete the installed folder and copy the new version over it (do not merge by hand). Re-run `install-agents.mjs` if you installed native agents.
- Your project's `.product/` files are never touched by upgrades. Check `CHANGELOG.md` for artifact-format changes; `pi validate` reports anything that no longer matches.

## Remove

```bash
rm -rf ~/.claude/skills/product-intelligence ~/.agents/skills/product-intelligence   # personal
rm -rf .claude/skills/product-intelligence .agents/skills/product-intelligence       # project
node <skill-dir>/core/scripts/install-agents.mjs --agent all --scope user --remove    # before deleting the skill, if you installed agents
```

`.product/` in your projects is your data; delete it only if you want to discard the approved context and decisions.

## Other skills in this repository

Every authored skill installs the same way and on its own: replace the name after `--skill`. For example, growth-strategy (Claude Code and Codex, project level):

```bash
npx skills add sourav-ojha/agent-skills --skill growth-strategy -a claude-code -a codex
node .claude/skills/growth-strategy/core/scripts/install-agents.mjs --agent all --scope project --project-dir .   # optional native agents
```

Its helper is `core/scripts/gs.mjs` and its state is `.growth/` in your project (commit it; `.growth/performance/` is git-ignored for raw analytics exports). Host notes: [Claude Code](../skills/growth-strategy/adapters/claude-code/README.md), [Codex](../skills/growth-strategy/adapters/codex/README.md). Per-skill guides: [guides](guides/README.md).

## Verified paths

| Fact | Source |
|---|---|
| Claude Code skills: `~/.claude/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md` | https://code.claude.com/docs/en/skills (accessed 2026-11-16) |
| Claude Code agents: `~/.claude/agents/*.md`, `.claude/agents/*.md` | https://code.claude.com/docs/en/sub-agents |
| Codex skills: `~/.agents/skills`, repo `.agents/skills` | https://developers.openai.com/codex/skills (redirects to learn.chatgpt.com) |
| Codex agents: `~/.codex/agents/*.toml`, `.codex/agents/*.toml` | https://learn.chatgpt.com/docs/agent-configuration/subagents |
| `skills` CLI paths and `--copy`, `-a`, `-g`, `--skill` | https://github.com/vercel-labs/skills; install tested locally with `--copy` (both agent dirs populated with the full folder) |

These ecosystems move quickly; if something is not picked up, consult the linked docs.
