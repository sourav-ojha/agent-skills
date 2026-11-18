# Checks

`ea analyze` runs these deterministic checks on probe output. Thresholds are in `ea config` and are heuristics: results are **candidates** for a person to confirm, not verdicts.

## Layout (collect.js geometry)
| Rule | What it measures | Notes |
|---|---|---|
| `layout.overflow-x` | document wider than the viewport | High |
| `layout.column-imbalance` | in a side-by-side row, a column whose content fills under `imbalance_max_fill` of the row height (and leaves `imbalance_min_empty_px` empty) while a sibling fills 80% or more | The "advanced panel beside a small image box" case. No standard defines wasted space; we define it. |
| `layout.section-gap` | vertical gap above a section more than `section_gap_multiplier` times the median and over `section_gap_min_px` | Low |
| `a11y.target-size` | interactive elements under 24x24 CSS px (WCAG 2.2 SC 2.5.8) | Spacing exceptions need a human look |
| `a11y.image-alt` | images with no `alt` attribute | |

## Footer and navigation
`nav.footer-missing`, `nav.footer-sparse` (fewer than `footer_min_links`), `nav.footer-ungrouped` (many links, fewer than two labelled groups), `nav.features-not-surfaced` (footer and navigation link text covers too few of the product's capabilities; pass the capabilities list from PRODUCT.md or the user). Evidence that footer links help ranking is weak and conflicting; treat these as usability and discoverability findings.

## SEO (technical)
Head: title, description, h1, canonical (absolute, same host), robots meta, lang, viewport meta, JSON-LD syntax and `@type`. Links: not crawlable (`<a>` without a real href), empty or generic anchors. Rendering: raw HTML versus rendered DOM (title, h1, link count). Site level: duplicate titles and descriptions, click depth from home (heuristic, weak evidence), orphans (in the sitemap, linked from none of the audited pages), robots.txt blocking audited pages, missing Sitemap line. Each cites a Google Search Central page. Structured data is checked for syntax and type only; say it is **not validated by Google's tools** and give the user the Rich Results Test to run.

## Environment rules
Staging `noindex`, a canonical pointing at production and a restrictive robots.txt are expected on staging: reported as Info with a reminder to check production, Critical or High only when the audit is declared `production`.

## Not checked (say so in the report)
Rankings, impressions, keyword demand, backlinks, field Core Web Vitals (INP is field-only; lab data is a proxy), content quality, whether structured data earns rich results, crawl budget on small sites.

## Judgment checks (visual-judge, always labelled opinion)
Visual hierarchy, whether whitespace or a footer feels wrong, copy and call-to-action clarity, and the parts of Nielsen's heuristics that cannot be measured (consistency across screens, recognition over recall). A judgment finding needs: an element crop, the numbers that prompted it, and agreement in 2 of 3 independent passes.

## Adding probes
New probes go in `core/probes/` as one function that returns JSON, read-only. Add the matching check in `core/scripts/lib/checks.mjs` as a pure function over that JSON with a test using a snapshot captured in a real browser.
