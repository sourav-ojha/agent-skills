# Guide: autonomy and memory

Three skills about *how* an agent works with you: without questions, with a clear habit of checking skills first, and learning from what went wrong.

| Skill | What it does |
|---|---|
| `autonomous` | Runs a multi-step task end to end without asking you anything: resolves ambiguity from project docs and standard practice, plans in phases, has a fresh-context sub-agent review each phase and the whole plan, then ends with a decisions-and-assumptions summary |
| `retro` | After a significant piece of work, extracts mistakes, your corrections and new project facts, and files each in the right place: global memory, the project's `CLAUDE.md`, or `.claude/retro.md` |
| `using-superpowers` | The session-start habit: check whether a skill applies before acting. Background behaviour, not something you invoke |

## autonomous

Start: `/autonomous <task>`, or say "don't ask me questions", "I'm not available", "figure it out yourself".

Its one rule: blocking on a question is a failure; deciding wrong and flagging it is a success. It still has **hard stops** (it will not do irreversible or outward-facing things unattended), and you review the assumption list at the end.

| If you want unattended… | Use |
|---|---|
| a product research run | `full auto` in [product-intelligence](product-intelligence.md): gate-aware, and opportunity decisions still come back to you |
| any other multi-step task | `autonomous` |

Both end with a list of what was decided for you. Read it before accepting the result.

## retro

Start: `/retro`, "what did we learn", "log this so we don't repeat it". It also fires itself after a session where the agent was visibly wrong and you corrected it.

It checks existing memory first and updates rather than duplicates, then tells you in a few lines what it saved and where. It does not store in-progress state ("where we left off"), only what was learned.

## using-superpowers
Installed so every session begins by checking for an applicable skill. You do not call it. If an agent skips an obviously relevant skill, name the skill in your message.

## Combine with
- **[skill-insights](skill-insights.md)** measures skills across sessions; `retro` captures lessons from one session. Use `retro` for what *you* learned, `skill-insights` for what the *skills* cost.
- **[build-workflow](build-workflow.md)** and **[review-and-quality](review-and-quality.md)**: run `retro` after a hard debugging session or a contentious review.
