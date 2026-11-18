# Skill guides

One guide per skill, or per small family of skills that are used together. Each guide says **when to use it, how to start it, what it produces, what it combines with, and what it will not do**.

## Pick a skill

| I want to… | Use | Guide |
|---|---|---|
| Decide *what* to build (market, competitors, prioritised ideas, specs) | `product-intelligence` | [product-intelligence](product-intelligence.md) |
| Build an approved spec or a raw idea, with tests and evidence | `implementer` | [implementer](implementer.md) |
| Deliver every ready spec unattended: PR, CI, squash merge, next | `delivery-orchestrator` | [delivery-orchestrator](delivery-orchestrator.md) |
| Explore an idea, plan it, execute the plan step by step | `brainstorming` → `writing-plans` → `executing-plans` / `subagent-driven-development` | [build-workflow](build-workflow.md) |
| Review a PR (quick or deep) or respond to review feedback | `pr-review`, `pr-review-orchestrator`, `requesting-code-review`, `receiving-code-review` | [review-and-quality](review-and-quality.md) |
| Fix a bug properly, or prove work is really done | `systematic-debugging`, `verification-before-completion` | [review-and-quality](review-and-quality.md) |
| Hand off a task and not be asked questions | `autonomous` (or `full auto` in product-intelligence) | [autonomy-and-memory](autonomy-and-memory.md) |
| Capture what a session taught you | `retro` | [autonomy-and-memory](autonomy-and-memory.md) |
| Find what is wrong in the live app (empty space, weak footer, SEO, accessibility) and get fix specs | `experience-audit` | [experience-audit](experience-audit.md) |
| Get organic traffic: keywords, landing pages, distribution channels, measurement, AdSense readiness, a 90-day roadmap | `growth-strategy` | [growth-strategy](growth-strategy.md) |
| See what my skills cost, which I actually use, how to improve them | `skill-insights` | [skill-insights](skill-insights.md) |

## Three ways the skills fit together

**1. Idea to shipped feature** (the main pipeline)

```
product-intelligence ──specs──► implementer ──► PR review ──► merge
 (what to build)                (build it)      (review-and-quality)
        ▲                            │
        └──── delivery written back to the spec (status: Implemented) ────┘

Hands-off version: delivery-orchestrator runs implementer → PR → CI → squash merge for every ready spec, one by one.
```

**2. Build workflow, no product research** (you already know what you want)

```
brainstorming → writing-plans → subagent-driven-development ┐
                                 or executing-plans          ├→ finishing-a-development-branch
                          test-driven-development + using-git-worktrees run inside
```

**3. Fix what is already built** (the live app, not new features)

```
experience-audit ──fix specs──► implementer ──► PR review ──► reaudit (verified fixed)
 (measure, you decide)
```

**4. Grow what is built** (organic acquisition)

```
growth-strategy ──approved items──► roadmap.md (human tasks) + handoff specs ──► implementer ──► sync ──► refresh
 (research, you decide)      reads .product/ and .experience/ when present
```

**5. Improvement loop** (the skills improve themselves)

```
any skill runs ──► .skill-runs/ logs + transcripts ──► skill-insights ──► changes to the skill ──► re-measure
```

## Which build skill: `implementer` or the build workflow?

| | `implementer` | build workflow (`brainstorming` … `finishing-a-development-branch`) |
|---|---|---|
| Starts from | a spec (e.g. from product-intelligence) or a raw idea | a conversation about an idea |
| Planning | task graph with owned files, tracked by a helper | a written plan document |
| Parallelism | tasks on disjoint files, each in its own worktree | fresh sub-agent per task, review after each |
| Strength | acceptance criteria, evidence, delivery written back to the spec | design thinking up front, per-task review gates |

They are alternatives, not layers. Use `implementer` when you have specs from product-intelligence; use the build workflow when the design is still open.

## Where each skill comes from

Some skills are authored here (`product-intelligence`, `implementer`, `delivery-orchestrator`, `experience-audit`, `growth-strategy`, `skill-insights`), some are vendored from other repositories, and some are imported unchanged from the author's own set. `skills.lock.json` records the origin of each one. The guides for vendored skills describe how they are used in this setup, not their upstream docs.

Install any skill with `npx skills add sourav-ojha/agent-skills --skill <name> -a claude-code` and update with `npx skills update`. See [installation](../installation.md).
