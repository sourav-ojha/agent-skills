# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/) per skill (`metadata.version` in each `SKILL.md`).

## [Unreleased]

### Added (implementer skill 0.1.0)
- New skill `implementer`: tier-triaged (T0-T3) multi-role implementation (architect, software-engineer, QA, reviewer, optional security/database lenses), TDD and acceptance-criteria driven, few high-value tests with pruning, plan sign-off for T2/T3, commits on a feature branch.
- `core/scripts/impl.mjs`: dependency-graph task ledger with file-ownership-aware parallel batches; only a recorded command with exit 0 and criteria mapped to tests can mark a task passed. Rulings log.
- `install-agents.mjs` generates Claude Code agents (`impl-*.md`) from `roles.json`; read-only roles get no edit or shell tools.
- Repo validator: adapter-sync check applies only to skills that export `renderAll`.

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
