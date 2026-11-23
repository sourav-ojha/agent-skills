# Config wizard: audit of other config files

Date: 2026-11-23. Scope: every config-bearing file under `skills/`. Method: grep for `config.schema.json`, `config.default.json`, `parse*Config`, files named `config*`, and a listing of every `*.json` under `skills/`. Key counts are leaf keys in the file as it ships.

Rule used: a config with a handful of keys, or with keys nobody edits by hand, does not get a wizard. A wizard is worth it only where people edit many keys with cross-rules and mistakes are costly.

## Results

| File | Keys | Who edits it | Wizard? |
|---|---|---|---|
| `skills/delivery-orchestrator/core/scripts/lib/configschema.mjs` (schema for `.product/delivery.json` and `~/.factory/config.json`) | about 40 project, 6 local | A person or an AI draft, per project | Done (this work). |
| `skills/delivery-orchestrator/templates/delivery.json` | example of the above | Copied by `config --write` | No: template only, covered by the wizard above. |
| `skills/product-intelligence/core/schemas/config.schema.json` | the schema for the file below | Read by the validator only | No: it is the schema, not a config. |
| `skills/product-intelligence/core/config.default.json` | about 29 (scoring weights and tiers, freshness days, research limits, gates, model tiers) | Defaults ship with the skill; a project may override a few keys in `.product/config.json`, rarely | No: defaults are rarely overridden, one cross-rule (weights sum, `consider_min <= recommend_min`) is already checked in its `lib/config.mjs`. Revisit if overrides become common. |
| `skills/growth-strategy/core/schemas/config.schema.json` | the schema for the file below | Validator only | No: schema. |
| `skills/growth-strategy/core/config.default.json` | about 16 (freshness, research, gates, models) | Same pattern as product-intelligence; override file `.growth/config.json` rarely written | No. |
| `skills/experience-audit/core/config.default.json` | about 20 (environment, limits, thresholds, models) | Defaults ship with the skill; `<base>/config.json` overrides are merged per top-level key | No: a handful of tunables, no safety gates. |
| `skills/implementer/core/config.default.json` | 3 (model tier aliases) | Copied and edited for `install-agents.mjs --config` | No: three keys. |
| `core/roles/roles.json` in each of four skills | role tables | Maintainers of the skill | No: skill content, not user config. |
| `skills/delivery-orchestrator/core/settings/builder.json` and `skills/delivery-orchestrator/core/settings/author.json` | Claude Code settings for factory sessions | Maintainers; the driver refuses user overrides outside an allowlist | No, and a wizard would be wrong: these are a security boundary. |
| `templates/*.json` in implementer, experience-audit and growth-strategy (plan, finding, capabilities, item, keyword, source, baseline, review) | record templates | Scripts fill them | No: not config. |

## Verdict

No other config is worth a wizard today. The closest candidates are the product-intelligence and growth-strategy override files (`.product/config.json` and `.growth/config.json`), which share a shape (scoring, freshness, research, gates, models). If a person starts editing those often, that case gets its own plan.

## If one is added later (its own plan, not part of this one)

- It receives a byte-identical copy of `lib/wizard.mjs`, guarded by a test in the style of the `runlog.mjs` copies (`the runlog copies in every skill with helpers stay identical`), because skills must install alone.
- `wizard.mjs` has no imports, but it currently holds delivery-specific cross-key rules, keyed by key path. They must move behind an injected hook (for example a `rules` object passed to `walk`) before any copy is made, otherwise every copy carries delivery's rules. The rules today:
  - `autonomy.level`: setting it drops `merge.mode` (one spelling of the setting only).
  - `verification.required` turning true: queues the factory keys `app.start`, `app.base_url`, `app.ready`, `readiness`, `readiness.min_level`, `local_checks` (`FACTORY_PULL`), and sets `readiness.min_level` to 4 when absent.
  - `app.ready`: a special `ready` type that asks `url` or `log_pattern`, then `timeout_s` (1 to 600), and drops the other key; the `url` default takes its port from `app.base_url`.
  - `app.base_url`: the `url` type asks for a port and accepts only `http://localhost:<port>` or `http://127.0.0.1:<port>`.
  - `local_checks`: a `local_checks` type that takes a JSON array of `{name, command, timeout_s}`.
  - `readiness`: an `object-null` type, the parent that opts in to its children.
- `configcmd.mjs`, `configedit.mjs` and `factorycheck.mjs` also hold delivery rules (sensitivity, factory refusals); another skill would write its own versions of those.
- This task did not extract or copy `wizard.mjs`.
