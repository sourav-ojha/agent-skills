# Guide: experience-audit

Audits your **live web app** in a browser: layout and UX problems, footer and navigation, accessibility and technical SEO. product-intelligence reads your repository and the market; this skill looks at what users actually see. Read-only on the audited app; it never edits code.

Design and research basis: [design spec](../superpowers/specs/2026-11-18-experience-audit-design.md).

## When to use it
- The app has many features but the footer is thin or messy, pages have wasted space, internal linking is weak, or SEO basics are missing.
- After each release, to check nothing regressed (`reaudit`).
- Not for: deciding what to build (see [product-intelligence](product-intelligence.md)), building the fixes ([implementer](implementer.md)), or ranking promises. It cannot know rankings, keyword demand or backlinks.

## What you need
A reachable URL (local dev server or staging; production only if you say so) and a browser tool in your agent that can load pages, resize, run JavaScript and take screenshots (Playwright MCP, Chrome DevTools MCP, Claude in Chrome or the in-app browser). Without one it stops and says so.

## Start
```
/experience-audit audit --url http://localhost:3000
/experience-audit seo
/experience-audit audit /pricing
```
It proposes the audit matrix (routes, viewports 1440/768/390, states such as light/dark or an expanded panel) and waits for your OK.

## The flow

```
pre-flight ─► you confirm the matrix ─► survey + stabilise ─► probes (measure) ─► judgment (only what probes cannot decide)
      ─► consolidate (group by root cause, rank) ─► independent review ─► report ─► you decide ─► fix specs ─► implementer ─► reaudit
```

## How findings are trusted
| Kind | Means | Limit |
|---|---|---|
| `measured` | a probe or tool produced the number (overflow, link counts, missing tag, axe result) | any severity |
| `rule` | checked against a cited standard (WCAG 2.2, Google Search Central) | any severity |
| `judgment` | a model's visual opinion: needs an element crop, the numbers behind it, and 2 of 3 independent passes | labelled opinion, capped at Medium |
| `needs-data` / `needs-human-check` | the audit could not know (Search Console, field Core Web Vitals) or a tool could not decide | Info, listed for you |

Your empty-space example is caught by measurement (a column filling under half of the row height next to a full one) and reported as a candidate for you to confirm. "The footer looks disorganised" is measured as link count, labelled groups and how many of your product's capabilities the footer and navigation mention.

## Decisions
The report ends with a decision sheet. Reply in chat per finding or per group, for example: `approve group:nav:footer, reject F-1a2b3c4d, defer group:seo:links`. The helper records your words. Findings are ranked by severity divided by effort and grouped by root cause, so one component fix can clear many findings.

## What you get
`.experience/report.md` (ranked report, coverage, needs-data), `findings.json` (ledger), `decisions.md`, `evidence/` (screenshots and probe output; may hold personal data, so do not commit it), and `fixes/FIX-NNN.md` for each approved group: Given/When/Then criteria and a re-test, ready for `/implementer`.

## Re-audit
After the fixes land, run `reaudit` on the same matrix. A finding becomes **verified** only when its rule ran on its route and no longer reports it; anything that returns is flagged as a regression.

## Combine with
- **[product-intelligence](product-intelligence.md)**: if `.product/PRODUCT.md` exists, its capabilities feed the footer check and competitor footers are a benchmark. Research finds features to add; this finds what is wrong with what you have.
- **[implementer](implementer.md)**: one FIX spec per approved group.
- **[review-and-quality](review-and-quality.md)**: review the resulting PR.
- **[skill-insights](skill-insights.md)**: measure what an audit cost (`si export`).

## Limits
Visual judgment from screenshots is useful but fallible, so it is labelled and capped. Automated accessibility tools find only part of the problems; the report says what stays untested. Footer-link and click-depth advice rests on weak evidence and is marked as heuristic. Thresholds are tunable in `.experience/config.json`. Install steps and browser tool mapping: [adapter README](../../skills/experience-audit/adapters/claude-code/README.md).
