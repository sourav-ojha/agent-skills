# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/) per skill (`metadata.version` in each `SKILL.md`).

## [Unreleased]

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
