# Growth-strategy skill: design

Status: revised after an independent design review (2026-11-18, verdict PROCEED WITH CHANGES); resolutions at the end override the sections above where they differ.

## Intent
A sixth authored skill, `skills/growth-strategy`, that helps an independent website or software product build an **evidence-backed organic acquisition strategy**: search (keywords, intent, clusters, landing pages, content, internal links, technical SEO), distribution (communities, directories, backlinks, partnerships), measurement (Search Console, GA4, funnels) and monetization readiness (for example AdSense). It ends in a human-approved 90-day roadmap. First validation target: an image/document utility site (SizeTune); nothing in the skill may assume that product.

## Existing conventions reused (inspected 2026-11-18)
| Convention | Source | Reuse |
|---|---|---|
| Agent-neutral `SKILL.md` + `core/` + `references/` + `templates/` + `adapters/` | product-intelligence, experience-audit | same layout |
| Role registry `core/roles/roles.json` (tier reasoning/standard/fast), role `.md` ≤ 40 lines, generated Claude `.md` and Codex `.toml` agents committed under `adapters/*/agents/`, `install-agents.mjs --generate-defaults/--check`, `renderAll` + `lib/config.mjs#loadConfig` | product-intelligence | same; validator's adapter-sync check applies automatically |
| Model aliases only in `core/config.default.json`, `MODEL_RE` guard | both | same |
| Zero-dependency helper CLI owning state and gates; decisions only with `--by` and `--note "<user's words>"` | pi, ea | `gs.mjs` |
| Evidence tag `[E: class; confidence; source; date]` | product-intelligence | same grammar, classes adapted (below) |
| Symlink-safe writes (`ensureDir`, temp + rename, `O_NOFOLLOW`) | experience-audit | copied into `lib/state.mjs` (no cross-skill import: independent install) |
| `runlog.mjs` identical copy, `retro` command, `.skill-runs/` | all authored skills | identical copy, test-enforced |
| Validator per-skill required-file list, lock entry `origin: authored`, `package:<skill>` script, guide + catalog row + changelog | repo | same |

Not reused: product-intelligence's markdown-frontmatter registry (growth items need filtering and CSV export, so JSON is better), its hash-protected PRODUCT.md (growth baseline is a small JSON object; a content hash protects it the same way).

## Responsibilities and non-duplication
| Concern | Owner | growth-strategy does |
|---|---|---|
| What the product is, its competitors' features | product-intelligence | reads `.product/PRODUCT.md` (if approved) as baseline input; never writes `.product/` |
| Rendered-page SEO/UX/a11y measurement | experience-audit | imports `.experience/findings.json` (category `seo`) by id into its SEO audit; recommends `experience-audit seo` for page-level checks; only does site-level strategy checks itself (indexable page inventory vs demand, sitemap/robots presence, structured-data coverage, analytics instrumentation) |
| Exploring an open design | brainstorming | approved landing-page items needing design go through brainstorming before implementer |
| Building | implementer | `gs handoff` writes `.growth/handoff/GRO-NNN.md` mini-specs (implementer's mini-spec shape) for approved items owned by `implementer` |
| PR/CI/merge | delivery-orchestrator | never invoked; it consumes product-intelligence `FEATURE-NNN.md` only. Documented, not automated |
| Run measurement | skill-insights | `.skill-runs/growth-strategy.jsonl` via shared runlog + `gs retro` |

growth-strategy never edits application code, publishes, posts, creates accounts, submits to directories, emails partners, buys tools, or triggers another skill on its own.

## Roles (`core/roles/`)
| Role | Tier | Capabilities | Used by |
|---|---|---|---|
| `product-seo-auditor` | standard | read, search, web, shell-readonly | `audit` |
| `search-researcher` | standard | read, search, web | `research` (search track) |
| `distribution-researcher` | standard | read, search, web | `research` (distribution track) |
| `growth-reviewer` | reasoning | read, search, web | `review` |

The lead (the main agent) does consolidation and planning; no separate planner role (one fewer abstraction). Parallelism: `audit` ∥ `research` (search ∥ distribution) when both are requested (`full`); each command launches only its own roles. Small sites: lead may do audit itself; review must be a separate agent to be recorded as `independent`.

## Commands
| Command | Does | Agents |
|---|---|---|
| `init` | `gs init`, draft baseline (name, URL, category, audience, goals, geographies, languages, monetization intent, constraints) from repo, `.product/`, user | none |
| `audit` | product + technical SEO + analytics audit → `seo-audit.md` | auditor |
| `research` | keywords/SERP/competitors → `keywords.json` (+CSV), `competitors.md`; distribution → `distribution.md` | search ∥ distribution |
| `plan` | consolidate → `items.json` (roadmap candidates), `content-strategy.md`, `measurement-plan.md`, `monetization.md` | lead |
| `review` | independent review of plan + evidence → `gs review record` | reviewer |
| `full` | init → (audit ∥ research) → plan → review → STOP at Gate 2 | per phase |
| `refresh` | `gs refresh` lists stale sources/keywords/items and imported performance data; re-research only those; new run, history kept | only roles for stale areas |
| `status` | `gs status` with next step | none |

Gates: **Gate 1** baseline approval (`gs approve-baseline --by --note`) before audit/research (goals and geographies shape research). **Gate 2** per-item decisions (`gs decide GRO-001 approve|reject|defer|research --by --note`) after a recorded review that covers the current plan hash. `gs roadmap` renders `roadmap.md` (90 days) from **approved items only**; proposals are listed separately as "not approved".

## State: `.growth/` (version 1)
| File | Kind | Content |
|---|---|---|
| `growth.json` | JSON, helper-owned | version, baseline (+ `status`, `content_hash`, approved_by/at/note), phases `{audit,research,plan,review}` with `at`/`run`, review records, runs, refresh history, decision log (append-only) |
| `sources.json` | JSON | provenance: `S-NNN`, `url` or `ref` (`tool:<name>`, `user:<note>`, `repo:<path>`, `gsc:<file>`), title, `accessed` date, type (serp, competitor, documentation, community, directory, tool-export, user, repo), note |
| `keywords.json` | JSON | keyword, cluster, intent, geo, language, `volume`/`difficulty`/`cpc` each `{value, kind: measured|estimate|unknown, source}`, serp notes, competitor coverage, target page, priority P1–P3, evidence class, sources[], researched date, performance (from GSC import) |
| `keywords.csv` | generated | `gs export keywords` |
| `items.json` | JSON | roadmap candidates `GRO-NNN`: type (landing-page, content, technical-seo, internal-linking, distribution, measurement, monetization), title, rationale, target keywords, sources, evidence class + confidence, impact H/M/L (qualitative), effort S/M/L, window (weeks 1–4/5–8/9–13), owner (`implementer` or `human`), acceptance (Given/When/Then, required for implementer-owned), risks, status |
| `baseline.md`, `seo-audit.md`, `competitors.md`, `distribution.md`, `content-strategy.md`, `measurement-plan.md`, `monetization.md` | markdown from templates | narrative with evidence tags; sources by `S-NNN` |
| `roadmap.md`, `decisions.md` | generated | from approved items / decision log |
| `performance/` | user exports | GSC query CSV imported with `gs import gsc`; summary stored in `growth.json`, metrics merged into keywords as `measured` |
| `handoff/GRO-NNN.md` | generated | implementer mini-specs |

Item lifecycle: `proposed` → `approved` | `rejected` | `deferred` | `needs-research` → (`handed-off`) → `done`; refresh may mark `superseded` (with `superseded_by`), never deletes. Decisions are append-only and survive refresh.

## Evidence rules (enforced by `gs validate`)
Classes: `fact` (verified in a source), `estimate` (a number from a third-party tool or a reasoned range; names its source), `assumption`, `hypothesis` (confidence low), `unknown`.
1. A metric with a value needs `kind` `measured` or `estimate` and a `source` that is an existing `S-NNN` whose type is `tool-export`, `gsc` or `user` (no web-page "volume" scraping as measured). `kind: unknown` ⇒ `value: null`. No default numbers anywhere.
2. Every source has `accessed` (YYYY-MM-DD, not in the future) and a URL or ref; web URLs must be http(s).
3. Every keyword, competitor and item cites ≥1 source id that exists, except evidence class `assumption`/`hypothesis`/`unknown`.
4. `fact` or high confidence cannot rest only on `community` sources.
5. Items: impact is qualitative; any traffic number in an item must be in a `traffic_estimate` metric object (same rule 1). Confidence `low` items cannot be priority P1/window weeks 1–4 unless type is `measurement` or `technical-seo` (cheap foundations).
6. Markdown tags parse; `S-NNN` references exist; stale sources (> `freshness.source_max_age_days`, default 90) warn.
7. Duplicate keyword (same normalized keyword+geo) is an error; two items targeting the same primary keyword with different target pages is a cannibalization **warning**.
8. Untrusted text fields: one line, bounded, no control characters (copied into generated markdown and CSV; CSV cells beginning `= + - @` are prefixed with `'`).

## Safety
Hard rules in SKILL.md: read-only on application code (writes only `.growth/`); external content untrusted; never send private code, credentials or personal data in queries; no purchases, sign-ups, posting, submissions, outreach; decisions only from the user's words; never claim background monitoring; independent review recorded only when a separate agent ran (`--mode independent --reviewer <agent>`), otherwise `--mode self` with a reason, shown in status and roadmap. `gs decide` refuses without a review record matching the current `items.json` hash.

## Tests
`tests/validation/growth-strategy-*.test.mjs`: frontmatter/size/links/roles/adapter sync/runlog identity; schema + evidence validation (fabricated-number, missing source, future date, unknown-with-value, community-only fact, duplicate, cannibalization warning); gates (baseline required, review required and hash-bound, decide needs `--by/--note`, roadmap only approved); resume (`status` next step per phase); refresh (history snapshot, decisions preserved, stale list, GSC import merges measured metrics); review reporting (self vs independent shown); CSV export (escaping, formula-injection guard); single-skill install (copy only `skills/growth-strategy` to a temp dir and run init/validate); generic behaviour (three fixtures: image utility, SaaS, content site validate clean; no product name in methodology).

## Out of scope (v0.1)
GA4 API, Search Console API, paid keyword tool integrations (only user-provided exports), scheduled refresh, auto-publishing, multi-language content generation.

## Design review (independent architect, fresh context, 2026-11-18)
Verdict: PROCEED WITH CHANGES. Resolutions (these override the text above):

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | Critical | Handoff had no lifecycle; implementer close-out edits the spec it is given | `GRO-NNN.md` gets frontmatter `id`, `status: ready`, `source: growth-strategy`; written once, never regenerated; `gs sync` reads the implementer's `delivery: complete` / `status: implemented` back and marks the item `done`. Items needing design say "brainstorming first" in the spec. |
| 2 | Critical | Gate 1 advisory: agents do audit/research, not the helper | `gs phase done audit|research|plan` refuses unless the baseline is approved and its hash still matches; `plan` needs audit+research done; `review record` needs plan done. |
| 3 | High | Self-review fallback unlocks decisions | Review records need a reviewer report file (stored in `.growth/reviews/R-NNN.json`) with the plan hash. `gates.require_independent_review` (default true) makes `decide` refuse a self-review; only the user can turn it off in `.growth/config.json`. Plan hash covers `items.json`, `keywords.json`, `content-strategy.md`, `measurement-plan.md`, `monetization.md`, so any later edit (including refresh) needs a new review. |
| 4 | High | Evidence vocabulary contradictory | Classes: `fact, inference, estimate, hypothesis, assumption, unknown`. Metrics: `measured` only from an imported `gsc`/`analytics` source (with file sha256); `estimate` only from `tool-export` or `user` sources; no reasoned ranges. Tag grammar is product-intelligence's; the source slot also accepts `S-NNN`. |
| 5 | High | Numbers in markdown unchecked | `gs validate` warns (heuristic) on a number next to volume/traffic/searches/visits/difficulty/CTR words with no `S-NNN` on that line; reviewer checks the rest. |
| 6 | Medium | Over-engineering | Dropped `history/` (git + `superseded` + append-only decisions suffice) and `traffic_estimate` (item impact stays qualitative, numbers on items are rejected). Kept cannibalization as a cheap warning. Kept `import gsc` minimal because `refresh` must use performance data. Kept measurement and monetization as separate files (both are required artifacts). |
| 7 | Medium | GSC exports are query data | `init` writes `.growth/.gitignore` ignoring `performance/`; import stores only aggregates and metrics for tracked keywords, plus file sha256. |
| 8 | Medium | Missing layout items | `agents/openai.yaml`, validator required-file list, host-token test, and a required "Consent and policy readiness" section in the monetization template. |
| 9 | Medium | experience-audit ids unstable | Cite `.experience/findings.json` as a `repo` source with `sha256`; `validate` warns when the file changed since. |
| 10 | Low | delivery-orchestrator | Documented: GRO files never go in `features_dir`. |
| 11 | Low | P1 loophole | Low-confidence early items allowed only for `measurement`/`technical-seo` with `effort: S`. |
| 12 | Low | Status line | Fixed. |

## Implementation review (independent, 2026-11-18)
Code review verdict PASS WITH CHANGES; audience review (solo site owner) "safe and honest, but not yet actionable"; automated security review flagged agent install through symlinks. All fixed with regression tests (each gate fix mutation-checked):
- H1 review wash-out / tampering: findings from every review of the current plan count; review file sha256 stored and verified; FAIL verdicts and plan-level Critical/High block approvals.
- H2 forged measured data: `gsc`/`analytics` sources only via `gs import`; hash mismatch is an error.
- M1-M4: baseline re-approval reopens phases and is part of the plan hash; statuses must match the decision log (roadmap/handoff refuse otherwise); reviewer echoes the plan hash from `review start`; no decisions while phases are stale.
- Lows: duplicate ids in input, supersede needs a live target, strict source URLs, traffic numbers in `serp_notes`, geo-aware GSC import, review id validation.
- Audience: free-signal prioritisation ladder (P1 needs two signals), Keyword Planner ranges (`min`/`max` estimates), "Done when" required for human items and printed in the roadmap, served-location for SERP checks, no-link-by-default community guidance, AdSense invalid-traffic / low-value-content / certified CMP / Core Web Vitals / hreflang / upload-handling trust notes, solo quickstart.
- Security: project-scope `install-agents` refuses symlinked `.claude`/`.codex` paths and agent files and writes by temp file + rename.
Not changed (stated limit): an agent able to rewrite every state file at once can still forge state; the gate remains the user reading `decisions.md`.

## PR review (sourav-ojha/agent-skills#16, 2026-11-19)
Five specialist reviewers (correctness, architecture, tests, security, error paths); verdict REQUEST CHANGES, all addressed:
- Decisions store a hash of the approved item content; later edits make `validate`, `roadmap` and `handoff` refuse. `status` routes to an independent review after a self-review and to "fix and re-review" after a FAIL. Traffic numbers are refused in acceptance criteria and risks too. Missing plan files block decide, roadmap and handoff.
- State is saved before the decision log is appended and before the review file is created; review files are hash-checked before parsing; `file:` source refs must exist inside the project; Search Console exports must sit in `.growth/performance/` and unparsable numbers are refused; `sync` accepts CRLF frontmatter and warns on missing specs; `init` reads templates before writing; `decide` always validates the config.
- Generated markdown escapes HTML; very long markdown lines skip the numeric heuristic; unused config keys removed; the auditor role leaves page-level checks to experience-audit, which is cited by finding id without a hash.
- Tests: the surviving mutations (sync, roadmap filter, plan-level and High findings, `--update`, config errors, re-decide, supersede-of-done) are now caught; builds are cached per fixture and stage.
