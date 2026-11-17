# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/) per skill (`metadata.version` in each `SKILL.md`).

## [Unreleased]

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
