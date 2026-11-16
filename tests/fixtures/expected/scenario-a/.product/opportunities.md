---
type: opportunity-registry
last_research: 2026-11-16
review_mode: independent
decision_count: 2
decision_head: 91298e3c4737
---
# Opportunities

> Synthetic fixture: competitors are fictional and sources use example.com.

## Market Landscape

Last researched: 2026-11-16. Search scope: browser-based image resizing, "compress image online", open-source image compressors.

### Direct competitors

| Name | Positioning | Audience | Pricing | Key strengths | Key weaknesses | Evidence |
|---|---|---|---|---|---|---|
| ShrinkRay | Online compressor with batch upload | Casual users, bloggers | Free with ads; Pro $5/mo | Batch of 50 files, presets | Uploads files to its servers | [E: fact; high; https://example.com/shrinkray/pricing; 2026-11-16] |
| TinyPix Online | One-click compression | Casual users | Free | Simple UI | No format choice, 5 MB limit | [E: fact; medium; https://example.com/tinypix; 2026-11-16] |

### Indirect competitors

None found — searched: "desktop image resizer", "photo editor resize image" returned general editors that are heavier than the job requires [E: fact; low; search:search log 2026-11-16].

### Open-source alternatives

| Project | License | Last release / commit | Maintained? | Usable commercially? | Relevance | Evidence |
|---|---|---|---|---|---|---|
| open-squash | MIT | 2026-08-02 / 2026-10-30 | Yes, regular releases | Yes (MIT) | Component for in-browser WebAssembly codecs; not a product | [E: fact; high; https://example.com/open-squash; 2026-11-16] |

### Emerging products

None found — searched: "new image compressor launch 2026", product launch directories [E: fact; low; search:search log 2026-11-16]

### Adjacent products and markets

None found — searched: "image optimization CDN" (server-side, different buyer) [E: fact; low; search:search log 2026-11-16]

### Changes since previous research

First research run.

## Registry

| ID | Title | Status | Score | Confidence | Tier | Effort | Updated | Feature |
|---|---|---|---|---|---|---|---|---|
| OPP-001 | Batch image processing | Ready for Implementation | 83 | Medium | Recommend | M | 2026-11-16 | FEATURE-001 |
| OPP-002 | EXIF metadata stripping | Deferred | 70 | Low | Needs evidence | S | 2026-11-16 | - |
| OPP-003 | Dark mode | Discovered | - | - | - | XS | 2026-11-16 | - |

## Review Summary

Independent reviewer challenged OPP-001 differentiation (lowered 4 to 3: ShrinkRay already batches) and OPP-002 evidence (only one user-forum thread; confidence lowered to Low). OPP-003 dropped as pure parity with no evidenced user problem; kept as Discovered so it is not rediscovered. No Critical findings remain.

## Decision Log

| Date | ID | Decision | By | Note | Seal |
|---|---|---|---|---|---|
| 2026-11-16 | OPP-001 | approve | Fixture Owner | user: yes, build batch | 84ab2677b7db |
| 2026-11-16 | OPP-002 | defer | Fixture Owner | user: wait for more evidence | 91298e3c4737 |

## Opportunity Details

### OPP-001 — Batch image processing

- **Category:** feature parity
- **Source direction:** internal gap + competitive gap
- **Problem:** Users with several photos must repeat the resize flow per image [E: fact; high; repo:src/resize.js:1; 2026-11-16]
- **Proposed solution:** Accept multiple files, apply the same settings, download as a ZIP
- **Why it matters:** Removes the main friction for repeat use; the README already lists batch as planned [E: fact; high; repo:README.md:5; 2026-11-16]
- **Evidence:** ShrinkRay batches up to 50 files [E: fact; high; https://example.com/shrinkray/pricing; 2026-11-16]; users in a forum thread ask for batch in local tools [E: fact; low; https://example.com/forum/thread-1; 2026-11-16]
- **Competitive context:** Parity with ShrinkRay on batch, while keeping the no-upload advantage ShrinkRay lacks [E: inference; medium; ref:ShrinkRay uploads files; 2026-11-16]
- **Expected value:** More repeat sessions per user; stronger privacy-first positioning
- **Effort:** M — Canvas pipeline exists; needs file list UI and ZIP creation
- **Risks:** Memory pressure with large batches in the browser
- **Dependencies:** A client-side ZIP library (needs licence check)
- **Ratings:** user_value=5, strategic_alignment=5, market_opportunity=4, competitive_differentiation=3, business_impact=3, implementation_feasibility=4
- **Reviewer notes:** Differentiation lowered after review.

### OPP-002 — EXIF metadata stripping

- **Category:** differentiation
- **Source direction:** unresolved user problem
- **Problem:** Photos can leak location data when shared [E: hypothesis; low; n/a]
- **Proposed solution:** Strip EXIF by default with an opt-out
- **Why it matters:** Reinforces the privacy positioning
- **Evidence:** One forum thread mentions location leaks [E: fact; low; https://example.com/forum/thread-2; 2026-11-16]
- **Competitive context:** No competitor in the landscape advertises it [E: unknown; low; search:feature pages checked]
- **Expected value:** Differentiation among privacy-minded users
- **Effort:** S — Canvas re-encode already drops EXIF; needs confirmation and UX copy
- **Risks:** Some users want to keep orientation or copyright data
- **Dependencies:** None
- **Ratings:** user_value=3, strategic_alignment=5, market_opportunity=3, competitive_differentiation=4, business_impact=2, implementation_feasibility=4
- **Reviewer notes:** Single-thread evidence; needs more research before recommending.

### OPP-003 — Dark mode

- **Category:** UX improvement
- **Problem:** None evidenced; competitor parity only.
- **Reviewer notes:** Dropped after review: no user-problem evidence [E: unknown; low; search:no complaints found].
