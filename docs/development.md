# Development

```bash
npm run validate   # structure, spec compliance, references, adapters, neutrality, install docs
npm test           # 50+ tests: units, scenarios, gates, source protection, installer, clean install
npm run check      # both
```

Node 22+ for the repo tooling and tests (the skill helper itself runs on Node 20+). No dependencies to install.

## Repository layout

`skills/` skills · `scripts/` repo tooling (validator, packager) · `tests/validation/` tests · `tests/fixtures/repos/` synthetic target repositories · `tests/fixtures/expected/` reference `.product` artifacts (generated with the real CLI) · `tests/scenarios/` live-run rubrics · `docs/`.

## Changing Product Intelligence

| You change | Also do |
|---|---|
| `core/roles/roles.json`, tiers in `config.default.json`, agent templates in `install-agents.mjs` | `npm run agents:generate` (validator fails on drift) |
| Artifact sections or frontmatter (`schemas/artifacts.json`) | update templates, fixtures (regenerate with the CLI), validator tests |
| Lifecycle (`schemas/lifecycle.json`) | `pi.mjs` messages, `artifact-contracts.md`, gate tests |
| Evidence grammar (`lib/evidence.mjs`) | `evidence-standards.md`, every template/role that shows a tag, fixtures |
| Default weights | must still sum to 1 (validated); update `opportunity-prioritization.md` and fixture scores |

Regenerating a fixture's approval: set `status: draft`, `revision: 0`, remove approval fields, then `PI_TODAY=2026-11-16 node skills/product-intelligence/core/scripts/pi.mjs approve-product --by "Fixture Owner"` inside the fixture dir; use `decide`, `new-feature` and `transition` for the rest. `PI_TODAY` pins "today" for deterministic tests.

## Adding a new skill

1. `skills/<name>/SKILL.md` with `name` = folder name, a "what + when to use" description (≤1024 chars), `license`, `compatibility`, `metadata.version`.
2. Keep it self-contained: references, templates, helpers inside the folder. No imports from outside it.
3. Keep methodology agent-neutral; put host specifics under `adapters/`.
4. Add the skill to the README table, add tests, run `npm run check`.
5. Verify installation: `npx skills add . --list` then a real install into a temp directory with `--copy`.

## Releasing

Update `metadata.version` in the skill and `CHANGELOG.md`, run `npm run check`, `npm run package`, tag `product-intelligence-vX.Y.Z`. Publishing and pushing are manual decisions.
