# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/) per skill (`metadata.version` in each `SKILL.md`).

## [Unreleased]

### Fixed
- `install-agents.mjs` in product-intelligence, experience-audit and implementer did nothing (exit 0, no files) when run through a symlinked path, such as a symlinked skills folder or macOS `/var` → `/private/var`: the entry-point check compared an unresolved path with the resolved module path. It now compares real paths, as growth-strategy does; a test runs every skill's installer through a symlink.

### Added (growth-strategy 0.1.0)
- New skill `growth-strategy`: evidence-backed organic growth strategy for independent websites and products. Roles: product-seo-auditor, search-researcher, distribution-researcher (parallel), growth-reviewer (independent); commands `init`, `audit`, `research`, `plan`, `review`, `full`, `refresh`, `status`. Design: `docs/superpowers/specs/2026-11-18-growth-strategy-design.md` (independently reviewed; resolutions recorded there).
- `.growth/` state: `growth.json` (baseline, phases, reviews, append-only decision log, refreshes, performance imports), `sources.json` (provenance with access dates and file hashes), `keywords.json` (+ `gs export keywords` CSV, formula-safe), `items.json` (roadmap candidates), six markdown artifacts with required sections, `roadmap.md` from approved items only, `handoff/GRO-NNN.md` implementer specs.
- Helper `gs.mjs` enforces: no metric value without provenance (`measured` only from imported Search Console or analytics exports, `estimate` only from tool exports or the user, otherwise `unknown`/null); sources exist and are not future-dated; no traffic numbers on roadmap items; Given/When/Then for implementer items; a hash-checked approved baseline before any phase closes; decisions only after a review bound to the current plan hash, independent by default, with Critical/High findings blocking approval; decided items superseded rather than edited; item statuses must match the decision log; review files are hash-checked and a later clean review cannot clear earlier Critical findings; writes (including native agent installs) never follow symlinks. `import gsc` keeps only aggregates and tracked-keyword metrics.
- Claude Code and Codex agents generated from the role registry; tests cover the three fixture projects (image utility, SaaS, content site), evidence rules, gates, resume, refresh, CSV export and single-skill install.

### Added (experience-audit 0.1.0)
- New skill `experience-audit`: audits a live web app in a browser for layout/UX, footer and navigation, accessibility and technical SEO. A read-only collector probe returns a JSON snapshot; deterministic checks in `ea.mjs analyze` turn it into findings (measured, rule, or capped judgment) with severity, effort and root-cause group. A ledger, decision log, ranked report, fix specs for the implementer (`ea fix`) and re-audit verification (`ea reaudit`) complete the loop. Design: `docs/superpowers/specs/2026-11-18-experience-audit-design.md`. Ledger text that is copied into fix specs and reports is validated (one line, bounded, no control characters); outputs never follow symbolic links; fix ids are validated against path traversal.

### Added (delivery-orchestrator)
- New skill `delivery-orchestrator`: works through `FEATURE-NNN.md` specs with `status: ready` one at a time (optional `depends_on`): feature branch, the implementer skill, PR, wait for CI, squash merge of the exact commit CI verified, sync the base, next. State in `.delivery/queue.json` (resumable); a helper (`deliver.mjs`) enforces the state machine and every merge precondition.
- Guard rails: merges only with `--merge` and the user's words; the run stops when the repo has no CI (`--no-ci` is explicit); T3 work and changes to CI or `CODEOWNERS` files are held for a person; capped CI fix rounds; circuit breaker; never force-push, `--admin` or `--auto`; stale head, behind and conflicting PRs handled; titles and reasons sanitised, no shell.
- `implementer --unattended` and `--name <slug>`: nothing waits for a person; every "stop and ask" case ends the run as `BLOCKED` with the question.
- Tests run a real git repo with a bare origin against a fake `gh`.
- Project config `.product/delivery.json` (`deliver config [--write]`): GitHub account (token held in memory, verified login and write access), base branch, `protected_branches` (default main, master, prod, production, release/*: never merged into, flags cannot override), standing merge mode, required and ignored CI checks, `local_checks` run by the orchestrator, `hold_paths`, limits, `implementer_notes`. The file must be committed and identical on the base branch; a feature that edits it is held.

### Added (arsenal: vendoring and bootstrap)
- `skills.lock.json` plus `scripts/skills.mjs` (`status`, `check`, `vendor`, `update`, `accept`, `bootstrap`): pinned, license-tracked vendoring with a dry-run-first `update` and a safe `bootstrap` that never overwrites unmanaged items or follows symlinks.
- Ported from the global skills, chosen by real usage: autonomous, pr-review, pr-review-orchestrator, phased-review, retro, and the deep-pr-review and pr-review commands (imported as-is). Vendored a Superpowers subset (MIT, v7.0.2, namespace rewritten): writing-plans, executing-plans, subagent-driven-development, brainstorming, finishing-a-development-branch, systematic-debugging, test-driven-development, requesting/receiving-code-review, using-git-worktrees, using-superpowers, verification-before-completion. graphify and security-audit are pin-only (external).
- Hardened against hostile upstreams and projects: `vendor`/`update` refuse symlinks anywhere on the source path and a non-regular LICENSE (validated before anything is written); project-scope `bootstrap` refuses a symlinked `.claude`, `skills`, `commands` or manifest, and writes the manifest by temp file + rename.
- Repo validator reads the lock: imported and vendored skills get spec-level checks only, and lock consistency (entries, hashes, licenses) is enforced.

### Added (run telemetry)
- `pi` and `impl` write a metadata-only run log (`.skill-runs/<skill>.jsonl`, self-ignoring; off with `SKILL_RUNLOG=off`): command, outcome, duration, ids and counts, never prompts, code or free text. `impl` records tier, input spec id, plan size, fix rounds, blocked tasks, rulings count.
- New `retro` command on both helpers: a short agent self-report (unclear / skipped / improvised / suggest) logged at the end of a run.
- `si export` (skill-insights 0.2.0): one redacted bundle per project (run summaries, self-report, transcript cost) to bring back for skill improvement. Structural fields are allowlisted, free text is redacted (paths, emails, URLs, secrets, token shapes), `--no-notes` drops the self-report, `--out FILE` writes it owner-only without following symlinks. Run-log writes never follow symlinks; `verify-clean` ignores only our own root `.skill-runs/*.jsonl` (and tracked files always count).

### Added (skill-insights 0.1.0)
- New skill `skill-insights`: read-only analyzer over Claude Code transcripts. `si inventory` (real usage per skill, installed-but-unused), `si runs`, `si report` (tokens, wall time, tool errors, repeated reads, large outputs per skill). Detects both model-invoked and slash-command skill runs. Output is redacted: no paths, project names or message text.

### Fixed (implementer skill)
- Delivery status is now written back. Close-out records a `## Delivery log` row and `delivery: none|partial|complete` in the spec, sets `status: implemented` plus `pi transition ... Implemented` only when every criterion is delivered, and lists non-code pending items. New `impl report` derives delivered vs pending criteria from the ledger. The skill also says where the helper lives and to stop (T2/T3) if it is missing.

### Added (implementer skill 0.1.0)
- New skill `implementer`: tier-triaged (T0-T3) multi-role implementation (architect, software-engineer, QA, reviewer, optional security/database lenses), TDD and acceptance-criteria driven, few high-value tests with pruning, plan sign-off for T2/T3, commits on a feature branch.
- `core/scripts/impl.mjs`: dependency-graph task ledger with file-ownership-aware parallel batches; only a recorded command with exit 0 and criteria mapped to tests can mark a task passed. Rulings log.
- `install-agents.mjs` generates Claude Code agents (`impl-*.md`) from `roles.json`; read-only roles get no edit or shell tools.
- Repo validator: adapter-sync check applies only to skills that export `renderAll`.

### Added (run modes)
- `widen` modifier: broader competitor reach (`research.widen_competitor_multiplier`), new source types, a second discovery pass targeting `research.widen_target_candidates` candidates examined. Admission test and confidence caps unchanged.
- `override` modifier: rerun regardless of freshness; approvals are not reset. (Freshness was never enforced in code; the agent could mistake fresh research for "nothing to do".)
- `full auto`: unattended run with a confidence review per phase, `.product/attention.md` queue, one final report and decision sheet. Gate 1 can be approved by recorded delegation (`approve-product --delegated --note`, shown in `pi status` as `approved_by_delegation`); opportunity decisions are never delegated and the helper refuses `--delegated` anywhere else. Controlled by `gates.allow_delegated_approval` (default true); `human_confirmation: tty` still requires a person.

### Fixed (third independent review)
- `gates.human_confirmation: "tty"` now works from a real terminal (the earlier build never accepted "yes"); it is documented as a deterrent, not a boundary.
- `decide` refuses to append to a Decision Log that already fails its integrity check, so a damaged log cannot be made to look legitimate.
- Each decision seals a digest of the opportunity (title, scores, detail block) in a new `Content` log column; rewriting an approved idea is detected. Logs written before this change must be regenerated.
- `decision_count` is a required frontmatter field; superseded specs are validated for linkage only; `new-feature` and the Ready transition require an unmodified baseline.
- Evidence sources are canonicalised (path and URL aliases count once; `.product/` and `.git/` never count).
- Stray Revision History rows, a hand-edited `last_reviewed`, quoted or U+2028 names, symlink retargeting, the `last_research: never` template value, and note validation order are fixed.
- Docs: `pi snapshot` at the start of every run, `--discard` in help, accurate list of commands that refuse without an approved baseline.

### Fixed (second independent review)
- Decision Log: row count and head seal are kept in the frontmatter, so truncating the log or hiding rows behind a gap is detected.
- `verify-clean`: tracked files are never excluded (even under `build/`, `dist/`, `target/`), file permissions are hashed, more bulk folders are skipped for untracked files only.
- Confidence cap counts only primary sources (https or an existing repo file); `search:`/`ref:` can only back low-confidence facts.
- `decide` and `transition ... Proposed` require an approved, unmodified PRODUCT.md; approval metadata must match the Revision History.
- Approved items can be reversed by the user (spec marked `superseded`); `confirm-product` re-confirms a stale baseline without a new revision.
- Validator reports stray files in `features/`, rubric changes, malformed history rows; rating names may contain digits; pipe escaping and private-host checks corrected.

### Added
- Optional `gates.human_confirmation: "tty"` makes the user-only commands require an interactive terminal.

### Added
- `product-intelligence` 0.1.0: product discovery, market and competitive research, opportunity prioritization, independent review, and feature-spec handoff, with approval gates enforced by a helper CLI.
- Agent adapters for Claude Code and Codex generated from one role registry.
- Repository validator (`scripts/validate-skills.mjs`) and test suite with two synthetic scenarios and failure scenarios.
