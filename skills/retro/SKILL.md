---
name: retro
description: Run a retrospective at the end of a debugging session or any significant piece of work — extract mistakes Claude made, corrections/preferences the user gave, and new project facts learned, then write them into the right durable store (global memory, project CLAUDE.md, or a per-project retro log). Use this whenever the user says "/retro", "what did we learn", "update memory from this session", "log this so we don't repeat it", or after wrapping up a hard debugging session, a contentious back-and-forth, or a task where the user corrected Claude's approach more than once. Also trigger proactively — without being asked — right after a session where Claude was visibly wrong about something (bad assumption, architecture violation, wrong fix reverted) and the user then corrected it, since that is exactly the moment worth capturing before it's forgotten. Do not use this for saving where-we-left-off session state (that's the separate .remember system) — retro is about what was learned, not what's in progress.
---

# Retro

A session just happened. Something in it is worth remembering next time — a mistake Claude made and got corrected on, a preference the user stated, a fact about the project that came out mid-debugging. Left in the transcript, it evaporates. This skill's job is to pull it out and put it where a future Claude will actually see it again.

## Why this exists

Claude re-reads global memory (`MEMORY.md` + `memory/*.md`) and the project's `CLAUDE.md` at the start of every session. Anything true and durable that lives only in this session's transcript is invisible next time — the same mistake gets made again, the same correction gets given again. This skill closes that loop, once, at the point where the lesson is freshest and clearest.

It is deliberately retrospective and manual/semi-manual — it looks back at what just happened and decides what deserves to survive. It is not a running log of current work (that's `.remember/`), and it does not fire on every message — only when a session produced something worth keeping.

## When to run

- User explicitly invokes it (`/retro`, "log what we learned", "update memory from this").
- Proactively, right after: a session with a real debugging slog, a moment where the user corrected a wrong assumption or reverted an approach, or a task that surfaced a non-obvious project fact (a hidden constraint, a gotcha, a decision with a reason behind it).
- Skip it for trivial sessions (a one-line fix, a question that was just answered correctly the first time) — there's nothing to extract.

If you're not sure whether the session had enough substance, ask the user in one line rather than silently skipping or silently running.

## The three destinations — and how to choose

Something learned this session can go to up to three places. A single session often produces items for more than one — don't force everything into one bucket.

### 1. Global memory (`memory/*.md` + `MEMORY.md` index)

For anything that should follow the user across *any* project — how they like to work, corrections about Claude's process, cross-cutting preferences. This is the existing auto-memory system described in the environment's system prompt (types: `user`, `feedback`, `project`, `reference`). Use that exact frontmatter format and update `MEMORY.md`'s index with a one-line pointer.

**Locate the memory directory for the current project, don't hardcode it** — it's keyed by the cwd, e.g. `~/.claude/projects/<escaped-cwd>/memory/`. If you don't already know it from context, derive it: replace `/` with `-` in the absolute working directory path, prefix with `~/.claude/projects/`, append `/memory/`.

Before writing a new memory file, check `MEMORY.md` for an existing one to update instead of duplicating — same as the standing memory-saving rules already govern this.

**Goes here:** user preferences about how Claude should work ("stop doing X", "always ask before Y"), corrections that generalize beyond this one codebase, reference pointers to external systems.

### 2. Project `CLAUDE.md`

For facts specifically about *this codebase's* architecture, conventions, or constraints that Claude got wrong or that aren't already documented — the kind of thing that, if written down, would have prevented the mistake. Only add to `CLAUDE.md` if it's a durable rule, not a one-off event. If a relevant `CLAUDE.md` already covers the area, prefer tightening/correcting the existing section over appending a new one. Don't duplicate what memory already covers — architecture rules belong in `CLAUDE.md`; cross-project behavioral preferences belong in memory.

If the project has the `claude-md-management:claude-md-improver` or `claude-md-management:revise-claude-md` skill available, prefer invoking it for the actual `CLAUDE.md` edit — it already knows how to audit and integrate changes cleanly. Use this skill's own judgment only if those aren't available or don't fit.

**Goes here:** "the migration numbering must stay strictly ordered," "this domain's repo layer never imports X," a discovered gotcha about a library version pinned in this repo — anything a future Claude working in this exact codebase needs to know before touching related code again.

### 3. Per-project retro log (`.claude/retro.md` at the project root)

For the raw, dated "what happened" entry that doesn't rise to a standing rule but is still worth having a record of — root causes found, dead ends tried and abandoned, decisions made mid-session with their reasoning. This is a running append-only log, not an index like `MEMORY.md`.

Create `.claude/retro.md` at the current project's root if it doesn't exist yet. Append entries in reverse-chronological order (newest at top) using this format:

```markdown
## YYYY-MM-DD — <short title>

**What happened:** <1-3 sentences — the bug/task and why it was hard or notable>
**Root cause / lesson:** <the actual insight — why it happened, or what was true that wasn't obvious>
**Mistake made:** <what Claude got wrong, if anything, stated plainly>
**Also saved to:** <"global memory: <memory-name>" and/or "CLAUDE.md: <section>", or "n/a">
```

Keep entries honest and specific — vague entries ("fixed a bug") are worse than no entry.

## Process

1. **Reconstruct what happened.** Look back over the session: what was the task, where did Claude go wrong (if anywhere), what did the user correct or confirm, what facts about the project surfaced. Don't just pull the last few messages — a debugging session's real lesson is often near the start (the wrong initial theory) not the end (the fix).

2. **Classify each candidate item** into one or more of the three destinations above. It's fine for one lesson to be both a `CLAUDE.md` update and a retro log entry — the log records what happened, `CLAUDE.md` records the standing rule that resulted.

3. **Check for duplicates/conflicts first.** Read `MEMORY.md`, the relevant project `CLAUDE.md`, and (if it exists) `.claude/retro.md` before writing anything new. If a memory or rule already covers this ground but is now stale or wrong, update it in place rather than adding a contradicting entry.

4. **Write the updates.** Follow each destination's own format exactly (memory frontmatter schema, `CLAUDE.md`'s existing structure and tone, the retro log format above).

5. **Summarize for the user in a few lines** — what got saved, and where. Don't dump the full file contents back into chat; just say e.g. "Saved 1 feedback memory (stop doing X), added a CLAUDE.md note under Transactions, logged the debugging session in .claude/retro.md." This lets the user catch anything mis-classified before it's buried.

## What NOT to capture

Same exclusions that already govern the memory system apply here, plus:
- Don't log a session that was routine and error-free — there's no lesson, just log noise.
- Don't restate what's already correctly documented — only capture the delta.
- Don't write speculative "future improvement ideas" into the retro log unless the user actually asked for that; this is about lessons from what happened, not a backlog.
- Ephemeral, one-off facts about the current task's state belong in TodoWrite/plans or `.remember/`, not here.
