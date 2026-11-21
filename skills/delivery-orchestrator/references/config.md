# Project config: `.product/delivery.json`

Set the rules once per project. Create the file with `deliver config --write`, edit it, **commit it and merge it to the base branch**. `deliver config` validates it and shows the effective values.

```json
{
  "version": 1,
  "github": { "account": "work-login", "host": "github.com" },
  "base": "develop",
  "branch_prefix": "feat/",
  "features_dir": ".product/features",
  "protected_branches": ["main", "master", "prod", "production", "release/*"],
  "autonomy": { "level": "L1" },
  "merge": { "allow_tier3": false },
  "budgets": { "feature": { "tokens": 3000000, "turns": 400 } },
  "checks": { "required": ["unit-tests", "build"], "ignored": ["e2e", "e2e-*"], "allow_without_ci": false },
  "local_checks": [ { "name": "unit tests", "command": ["npm", "test"], "timeout_s": 900 } ],
  "hold_paths": ["migrations/", "infra/"],
  "limits": { "max_fix_rounds": 2, "max_failures": 2, "ci_budget_s": 1800 },
  "implementer_notes": "No e2e infrastructure here: unit and integration tests only."
}
```

Every key is optional. An unknown key or a wrong type is an error, so a typo cannot silently weaken a rule.

| Key | Meaning | Default |
|---|---|---|
| `github.account`, `github.host` | Which `gh` login to use when several are logged in. Its token is used for every `gh` call (and for `git` over https), held in memory only. The helper checks the token really is that account and that it can write to the repo. For SSH remotes git uses your SSH key; the setting then applies to `gh` only | `gh`'s active account |
| `base` | The branch every feature starts from (always its latest tip, fast-forwarded before each feature) and every PR targets and merges into | the repo's default branch |
| `protected_branches` | Branch names (globs: `*` within a segment, `**` across) this skill **never merges into**. If `base` matches, PRs are opened and checked but left for a person. Flags cannot override it | `main`, `master`, `prod`, `production`, `release/*`, `release-*` |
| `autonomy.level` | `L0` (PRs only, nothing merged; `--merge` is ignored when this is written explicitly) or `L1` (squash-merge on green). `L2` and `L3` are rejected. Writing it together with a disagreeing `merge.mode` is an error | from `merge.mode`, else `L0` |
| `budgets.feature.tokens`, `.turns` | Runaway caps per feature for `factory run` (tokens 10,000 to 1,000,000,000; turns 10 to 5,000). Tokens = input + output + cache creation. See [run-control.md](run-control.md) | 3,000,000 and 400 |
| `merge.mode` | `pr-only`: open PRs, never merge. `squash`: standing authorisation to squash-merge (equivalent to `--merge` each run) | `pr-only` |
| `merge.allow_tier3` | Also merge T3 work (auth, data, migrations, public API) | `false` |
| `checks.required` | CI checks that must be reported and pass (exact names). Empty: the base branch's required checks from branch protection are used | `[]` |
| `checks.ignored` | CI checks that never fail or hold a feature, for suites the project does not have or does not trust (globs). GitHub's own branch protection can still block a merge | `[]` |
| `checks.allow_without_ci` | Allow merging when no required or named check exists, on local evidence | `false` |
| `local_checks` | Commands the orchestrator itself runs before a PR is opened (argument list, no shell; `timeout_s` 1-3600). A failure keeps the feature in `building` until fixed | `[]` |
| `hold_paths` | Paths (globs, a trailing `/` means the folder) whose change needs a person to review before merge. CI files, `CODEOWNERS` and this config file are always held | `[]` |
| `branch_prefix` | Feature branch prefix | `feat/` |
| `features_dir` | Where `FEATURE-NNN.md` specs live | `.product/features` |
| `limits` | CI fix rounds per feature; blocked features in a row before the run stops; total CI wait per feature (seconds) | 2, 2, 1800 |
| `implementer_notes` | Up to 500 characters shown to the implementer for every feature (for example which kinds of tests exist) | `""` |

## Readiness keys: `app`, `tests`, `readiness`

All optional. `readiness` absent (`null`) means the project has not opted in to readiness checks. Commands are argument lists, never shell strings (at most 30 arguments).

| Key | Meaning | Default |
|---|---|---|
| `app.setup`, `app.start`, `app.stop`, `app.seed` | Commands to prepare, start, stop and seed the app locally (argument lists) | `null` |
| `app.base_url` | Where the running app answers. Only `http://localhost:<port>` or `http://127.0.0.1:<port>` | `null` |
| `app.ready` | How to know the app is up: exactly one of `url` (local URL, same rule as `base_url`) or `log_pattern` (regular expression, up to 200 characters), plus `timeout_s` (1-600) | `null`, `timeout_s` 120 |
| `app.logs_dir`, `app.env_example` | Relative paths inside the repository (same rule as `features_dir`) | `null` |
| `tests.setup`, `tests.all` | Commands that prepare and run the full test suite (argument lists) | `null` |
| `tests.timeout_s` | Time limit for the suite, an integer 1-3600 | `900` |
| `readiness.min_level` | Lowest acceptable readiness level, an integer 1-4 | `3` when `readiness` is present |
| `readiness.max_age_days` | How old a readiness result may be, an integer 1-90 | `14` when `readiness` is present |

## Verification keys: `verification`

Optional object; absent means `required: false`. Unknown keys inside it are errors.

| Key | Meaning | Default |
|---|---|---|
| `verification.required` | Whether a feature must pass the verification gate | `false` |
| `verification.scenario_approval` | `auto` or `human` | `auto` |
| `verification.session_timeout_s.builder`, `.author` | Time limit per agent session, integers 60-7200 | 1800, 900 |
| `verification.max_turns.builder`, `.author` | Turn limit per agent session, integers 5-1000 | 200, 40 |
| `verification.model.builder`, `.author` | Model name, or `null` for the default | `null` |
| `verification.test_globs` | Up to 50 path globs that identify test files | `[]` |

`factory run` additionally refuses unless, on `origin/<base>`: `verification.required` is `true`; `readiness.min_level` is `4`; `local_checks` is `[]` (they would run outside the untrusted-code sandbox: run them in CI); `checks.required` does not name `factory/verified`; and `github.host` is the origin host. It merges only with `merge.mode: "squash"`. Verification also needs `app.start`, `app.base_url` with a port, and `app.ready` (a `ready.url` must use the same port). The app gets `HOST=127.0.0.1` and `PORT=<port>` and must listen on 127.0.0.1: a `localhost` base URL is contacted as 127.0.0.1. Full list: [factory-driver.md](factory-driver.md#refusals-at-start-factory-run).

Local run-control settings (`wait_for_reset`, `max_wait_h`, `max_wait_weekly_h`, `keep_awake`, `fallback_model`, `budgets.day_tokens`) live in `~/.factory/config.json`, not in this file: [run-control.md](run-control.md#config-reference).

Environment for the factory driver: `FACTORY_HOME` (default `~/.factory`) holds scenarios, verdicts, the queue and the driver clone; `FACTORY_BUILDER_HOME` (default `<FACTORY_HOME>-builder`) holds the builder clone and must be outside `FACTORY_HOME`.

The queue file can be moved with the `DELIVER_QUEUE` environment variable (an absolute path; the folder is created with mode 0700 and a symlinked file or folder is refused). PR body files still live in `.delivery/`.

## Safety of the file itself
- It must be **committed and identical to the copy on `origin/<base>`** when a run starts, so the rules in force are the ones that were reviewed and merged. A local edit, or a copy that only exists on a feature branch, is refused.
- A feature that changes it is held for a person, and the run keeps using the policy it started with.
- `local_checks` commands run on your machine as you. They come from the reviewed base branch; read them as you would a CI script.
- Flags (`--base`, `--merge`, `--checks`, `--no-ci`, `--merge-t3`, `--features-dir`, `--max-fix-rounds`, `--max-failures`, `--ci-budget`) override the config for one run, **except** `protected_branches`, which only the file can change.
