# Guide: skill-insights

Measures how your skills really behave, from your session transcripts, then proposes changes to the skills. Read-only and private: it prints no paths, prompts or file contents (projects appear as short hashes).

## When to use it
- After a few real runs of a skill, to see what it cost and where it struggled.
- To find installed skills you never use and could remove.
- To review a run bundle someone sent you.
- Not enough data after one session: wait for several real runs before changing a skill.

## Commands
```
/skill-insights inventory      # which skills you use, which are dead weight
/skill-insights report         # cost and friction per skill
/skill-insights report --skill implementer
/skill-insights runs --skill implementer      # per-run detail (JSON for digging)
si export --dir . --out run-bundle.md         # package one project's runs for review
```
`si` is `node <skill-dir>/core/scripts/si.mjs`, e.g. `node ~/.claude/skills/skill-insights/core/scripts/si.mjs report --since 2026-11-01`.

Tips for useful numbers:
- Pass every skills folder so "never used" is accurate: `--skills-dir .claude/skills --skills-dir ~/.claude/skills`.
- Add `--since <date>` so old sessions do not skew results.
- Run the skills on real work first. No runs, no data.

## Improving a skill with it
1. `report` for the skill (and `runs --skill X --json`).
2. Pick at most 3 findings, each backed by a number, with the file to change and the expected effect.
3. Make the change in the skill's repository only when you agree.
4. Re-measure after the next real run. Do not claim an improvement without it.

If a bundle from `si export` includes the agent's own notes (from `impl retro` in [implementer](implementer.md)), read those first, then check them against the numbers.

## Limits
Attribution is approximate (a skill owns activity until the next skill call). Transcripts show cost and errors, not result quality. Sub-agent work may be billed outside the main transcript. Metrics reference: [`references/metrics.md`](../../skills/skill-insights/references/metrics.md).

## Combine with
Any skill. Most useful alongside [implementer](implementer.md) and [product-intelligence](product-intelligence.md), which write run logs to `.skill-runs/`.
