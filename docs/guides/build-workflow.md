# Guide: build workflow (brainstorming → plan → execute → finish)

A chain of eight skills for building something when the design is still open. Mostly vendored from [obra/superpowers](https://github.com/obra/superpowers) (see `skills.lock.json`); this guide covers how they are used together. If you already have a spec, [implementer](implementer.md) is the shorter path.

| Skill | Role in the chain |
|---|---|
| `brainstorming` | Turns an idea into an agreed design: finds out what you actually want, offers 2–3 approaches with trade-offs, writes a short or full design doc depending on size |
| `writing-plans` | Turns the design into a task-by-task plan with checkbox steps and a handoff |
| `subagent-driven-development` | Executes the plan with a fresh sub-agent per task and a review after each task |
| `executing-plans` | Executes the same plan inline in this session (one context, one final review) |
| `phased-review` | `/phased-review <plan-path>`: you implement a phase yourself, it tracks progress in `reviews/progress.md` and runs a review loop per phase |
| `test-driven-development` | Failing test first, minimal code, refactor. Loaded by the execution skills for each task |
| `using-git-worktrees` | Creates or verifies an isolated workspace before execution starts |
| `finishing-a-development-branch` | Verifies tests, then offers: merge locally, push and open a PR, or keep the branch |

## The flow

```
brainstorming ─► writing-plans ─► choose how to execute ─► finishing-a-development-branch
                                       │
          subagent-driven-development ◄┤► executing-plans         (both use test-driven-development
           (review after every task)   │   (inline, final review)   and using-git-worktrees)
                                       └► phased-review (you code, it reviews per phase)
```

## Choosing the execution style

| Situation | Pick |
|---|---|
| Plan is long, you want a review gate on every task | `subagent-driven-development` |
| You chose inline execution, or the host has no sub-agents | `executing-plans` |
| Tasks are tightly coupled | Neither parallelises well: do it by hand or brainstorm a different split |
| You want to write the code and have each phase reviewed | `phased-review` |

`writing-plans` ends by asking which of the first two you want. Subagent-driven costs a fresh context per task and per review; inline costs one context plus one final reviewer.

## How to start
Just describe what you want to build. `brainstorming` is meant to trigger before any creative work, then hands to `writing-plans`, then asks how to execute. You can also name a skill directly: "use writing-plans for this design".

## Combine with
- **[review-and-quality](review-and-quality.md)**: per-task review uses `requesting-code-review`; `verification-before-completion` governs every "done" claim; `systematic-debugging` when a task's test fails unexpectedly.
- **[autonomy-and-memory](autonomy-and-memory.md)**: `autonomous` can drive this chain with no questions to you; `retro` afterwards.
- **[implementer](implementer.md)**: the alternative when you have specs.

## Limits
Each skill carries its own rules and can be long (several are 200–340 lines). If the chain feels heavy for a small change, brainstorming sizes the work down to a short design doc; for a one-file tweak just ask for the change directly.
