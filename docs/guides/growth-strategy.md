# Guide: growth-strategy

Plans **organic growth** for an independent website or product: where users search and gather, what technically blocks you, and what to do in the next 90 days. Every claim has a source; every number has a provenance or is marked unknown; you approve before anything becomes the roadmap. It writes only `.growth/`; it never edits code, publishes, posts, signs up or submits anything.

Design: [design spec](../superpowers/specs/2026-11-18-growth-strategy-design.md).

## When to use it
- "How do we get traffic?", keyword research, landing-page or content plans, internal linking, distribution channels (communities, directories, backlinks), measurement setup, AdSense or other monetization readiness.
- Every few months, or after a Search Console export, to `refresh`.
- Not for: deciding product features ([product-intelligence](product-intelligence.md)), measuring rendered pages ([experience-audit](experience-audit.md)), building pages ([implementer](implementer.md)).

## What you need
Web search and fetch in your agent, the project folder (read-only), and ideally a Search Console query export or a keyword-tool export. Without exports, search volumes and difficulty stay **unknown**: the skill never guesses them.

## Solo quickstart
1. Export what you can for free and put it in `.growth/performance/` (git-ignored): Search Console → Performance → Queries, Pages and Countries; a Keyword Planner file from a free Google Ads account (ranges are fine).
2. `/growth-strategy init`, read the baseline, reply "approved" (or correct it).
3. `/growth-strategy full`, then answer the decision sheet in one message.
4. Do the human items in `roadmap.md`; give `handoff/GRO-NNN.md` files to `/implementer`.
5. Next month: export Search Console again and run `/growth-strategy refresh`.

## Start
```
/growth-strategy init        # drafts the baseline, then waits for your approval
/growth-strategy full        # audit ∥ research → plan → independent review → waits for your decisions
/growth-strategy research    # keywords and distribution only
/growth-strategy status
```
Codex: `$growth-strategy full`.

## The flow
```
init ─► you approve the baseline ─► audit ∥ (search research ∥ distribution research) ─► consolidate ─► plan
     ─► independent reviewer ─► you decide per item ─► roadmap.md ─► handoff specs ─► implementer ─► sync
                                                               ▲
                                    refresh (stale research, Search Console data; decisions kept)
```

## How evidence is kept honest
| Label | Means |
|---|---|
| fact | read in a cited source (URL or file) on a recorded date |
| inference | reasoned from cited facts; at most medium confidence |
| estimate | a number from your keyword tool export or from you; says whose |
| hypothesis / assumption | untested; low or medium confidence, listed for you |
| unknown | looked for, not found; the default for volumes and difficulty |

`measured` numbers only come from imported Search Console or analytics exports. Roadmap items have qualitative impact (H/M/L), never traffic promises.

## Decisions
The skill shows the items, the reviewer's verdict and the unknowns, then stops. Reply in chat, for example: `approve GRO-001 and GRO-003, defer GRO-004, research GRO-005`. Your words are recorded in `.growth/decisions.md`. Items with a Critical or High review finding cannot be approved until the plan is fixed and reviewed again. Without a separate reviewer agent the review is a self-review, and decisions stay blocked unless you add `{"gates": {"require_independent_review": false}}` to `.growth/config.json` yourself.

## What you get
`.growth/roadmap.md` (approved items by weeks 1-4, 5-8, 9-13; everything else under "Not approved"), `keywords.json` and `keywords.csv`, `seo-audit.md`, `competitors.md`, `distribution.md`, `content-strategy.md`, `measurement-plan.md`, `monetization.md`, `sources.json` (provenance), `decisions.md`, and `handoff/GRO-NNN.md` specs for approved technical items.

## Combine with
- **[product-intelligence](product-intelligence.md)**: an approved `.product/PRODUCT.md` seeds the baseline.
- **[experience-audit](experience-audit.md)**: run `seo` for page-level checks; growth-strategy cites its findings.
- **brainstorming** ([build-workflow](build-workflow.md)): for approved pages whose design is open.
- **[implementer](implementer.md)**: `/implementer .growth/handoff/GRO-001.md`, then `gs sync`.
- **[delivery-orchestrator](delivery-orchestrator.md)**: not connected; it ships product-intelligence `FEATURE` specs only.
- **[skill-insights](skill-insights.md)**: `si export` to see what a run cost.

## Limits
SERPs vary by location and personalisation; competitor traffic is unknown without a tool export; the evidence checks prove structure, not truth, so read the cited sources behind decisions that matter. Nothing runs in the background: refresh is manual. Install details: [Claude Code](../../skills/growth-strategy/adapters/claude-code/README.md), [Codex](../../skills/growth-strategy/adapters/codex/README.md).
