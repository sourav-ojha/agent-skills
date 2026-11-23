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

<!-- config-schema:project:start -->
**repo**

| Key | Meaning | Default |
|---|---|---|
| `github.account` | The gh login to use when several accounts are logged in. Its token is used for every gh call, so the right account opens and merges the PRs. Empty uses the active gh account. | `null` |
| `github.host` | The GitHub host name. Change it only for GitHub Enterprise. factory run requires it to match the origin remote host. factory run: must equal the origin host. | `"github.com"` |
| `base` | The branch every feature starts from and every PR targets. Empty uses the repository default branch. If it matches a protected branch, PRs are opened but never merged. | `null` |
| `branch_prefix` | Prefix for feature branch names, lower-case and ending in a slash. Keeps feature branches easy to find and to filter in CI. An empty string means no prefix. | `"feat/"` |
| `features_dir` | Folder inside the repository where FEATURE-NNN.md specs live. The orchestrator reads feature specs from here. It must be a relative path with no "..". | `".product/features"` |

**merge**

| Key | Meaning | Default |
|---|---|---|
| `protected_branches` (sensitive) | Branch globs this skill never merges into. If base matches, PRs are opened and checked but left for a person. Only this file can change it, no flag overrides it. | `["main","master","prod","production","release/*","release-*"]` |
| `merge.mode` (sensitive) | Older spelling of autonomy.level: pr-only is L0, squash is L1. The wizard writes autonomy.level and removes this key, so the two cannot disagree. Writing both with different meanings is an error. Values: `pr-only` (open PRs; nothing is merged), `squash` (squash-merge when CI is green). | `"pr-only"` |
| `merge.allow_tier3` (sensitive) | Also merge tier-3 work (auth, data, migrations, public API). Tier-3 changes are the riskiest. With this off they are always left for a person to merge. | `false` |
| `autonomy.level` (sensitive) | How far the orchestrator may go without a person. L1 merges to your base branch on its own. L2 and L3 are not available yet. Values: `L0` (PRs only; nothing is merged), `L1` (squash-merge when CI is green). factory run: must be L0 or L1; merging needs L1. | `"L0"` |
| `hold_paths` (sensitive) | Path globs whose change needs a person to review before merge. A trailing slash means the whole folder. CI files, CODEOWNERS and this config file are always held. | `[]` |

**ci**

| Key | Meaning | Default |
|---|---|---|
| `checks.required` | CI check names that must be reported and pass. Empty uses the base branch required checks from branch protection. Names must match exactly. factory run: must not name factory/verified. | `[]` |
| `checks.ignored` (sensitive) | CI check globs that never fail or hold a feature. For suites the project does not have or does not trust. GitHub branch protection can still block a merge. | `[]` |
| `checks.allow_without_ci` (sensitive) | Allow merging on local evidence when no CI check exists. Without CI there is no independent check on the change. Leave off unless the project truly has no CI. | `false` |
| `local_checks` (sensitive) | Commands the orchestrator runs itself before a PR is opened. Each is a name, an argument list and a timeout of 1-3600 seconds (default 900). They run as you, outside the sandbox, so read them like a CI script. factory run: must be empty; run them in CI instead. | `[]` |
| `limits.max_fix_rounds` | CI fix rounds allowed per feature. After this many failed fix attempts the feature is held for a person. | `2` |
| `limits.max_failures` | Blocked features in a row before the run stops. Stops a run that keeps failing from burning more budget. | `2` |
| `limits.ci_budget_s` | Total seconds to wait for CI per feature. A feature whose CI does not finish in this time is held. | `1800` |

**app**

| Key | Meaning | Default |
|---|---|---|
| `app.setup` | Command that prepares the app locally, as an argument list. Run once before the app starts, for installs or migrations. An argument list, never a shell string; up to 30 arguments. | `null` |
| `app.start` | Command that starts the app locally, as an argument list. Verification starts the app with it. The app gets HOST=127.0.0.1 and PORT, and must listen on 127.0.0.1. | `null` |
| `app.stop` | Command that stops the app, as an argument list. Used after verification. If empty the started process is signalled instead. | `null` |
| `app.base_url` | Where the running app answers, on localhost or 127.0.0.1 only. Must be http://localhost:<port> or http://127.0.0.1:<port>. Never https and never another host. factory run: needs a port. | `null` |
| `app.ready` | How to tell the app is up: a local URL or a log pattern, plus a timeout. Exactly one of url or log_pattern (a regex up to 200 characters). timeout_s is 1-600 and defaults to 120. factory run: a url must use the same port as app.base_url. | `null` |
| `app.logs_dir` | Folder inside the repository where the app writes logs. A relative path with no "..". Verification reads app logs from here. | `null` |
| `app.seed` | Command that seeds the app with data, as an argument list. Run after the app is up so scenarios start from known data. | `null` |
| `app.env_example` | Path of the example environment file inside the repository. A relative path with no "..". Used to tell the app which variables it needs. | `null` |

**tests**

| Key | Meaning | Default |
|---|---|---|
| `tests.setup` | Command that prepares the test suite, as an argument list. Run before the full suite, for installs or fixtures. An argument list; up to 30 arguments. | `null` |
| `tests.all` | Command that runs the full test suite, as an argument list. Readiness runs this to see whether the suite passes. An argument list; up to 30 arguments. | `null` |
| `tests.timeout_s` | Time limit in seconds for the full test suite. A suite that runs longer is stopped and counted as failed. | `900` |
| `verification.test_globs` | Path globs that identify test files. Verification uses them to tell test files from product code when checking a change. | `[]` |

**budgets**

| Key | Meaning | Default |
|---|---|---|
| `budgets.feature.tokens` (sensitive) | Token cap per feature for factory run. A runaway guard. Tokens counted are input, output and cache creation. Raising it lets a feature spend more. | `3000000` |
| `budgets.feature.turns` (sensitive) | Agent turn cap per feature for factory run. A runaway guard. Raising it lets a feature run longer before it is stopped. | `400` |

**verification**

| Key | Meaning | Default |
|---|---|---|
| `verification.required` (sensitive) | Whether a feature must pass the verification gate. With it on, a feature is only done when independent scenarios pass. Turning it off removes that gate. factory run: must be true. | `false` |
| `verification.scenario_approval` (sensitive) | Who approves the verification scenarios. auto lets the run continue unattended. human holds the feature until a person approves. Values: `auto` (scenarios are accepted without a person), `human` (a person approves the scenarios). | `"auto"` |
| `verification.session_timeout_s.builder` | Time limit in seconds for one builder agent session. A session that runs longer is stopped. | `1800` |
| `verification.session_timeout_s.author` | Time limit in seconds for one scenario author session. A session that runs longer is stopped. | `900` |
| `verification.max_turns.builder` | Turn limit for one builder agent session. Stops a session that loops without finishing. | `200` |
| `verification.max_turns.author` | Turn limit for one scenario author session. Stops a session that loops without finishing. | `40` |
| `verification.model.builder` | Model name for the builder session, or empty for the default. Letters, digits and . _ : - only, up to 80 characters. | `null` |
| `verification.model.author` | Model name for the scenario author session, or empty for the default. Letters, digits and . _ : - only, up to 80 characters. | `null` |

**readiness**

| Key | Meaning | Default |
|---|---|---|
| `readiness` | Opt-in switch for readiness checks; absent means the project has not opted in. Present, even as an empty object, turns readiness checks on with the defaults below. | `null` |
| `readiness.min_level` | Lowest acceptable readiness level. A project below this level is not ready for unattended runs. Applies when readiness is present. factory run: must be 4. | `3` |
| `readiness.max_age_days` | How many days old a readiness result may be. An older result is treated as missing and the check is run again. Applies when readiness is present. | `14` |

**notes**

| Key | Meaning | Default |
|---|---|---|
| `implementer_notes` | Text shown to the implementer for every feature. For facts the implementer cannot see, such as which kinds of tests exist. Up to 500 characters. | `""` |
<!-- config-schema:project:end -->

## Readiness keys: `app`, `tests`, `readiness`

All optional. `readiness` absent (`null`) means the project has not opted in to readiness checks. Commands are argument lists, never shell strings (at most 30 arguments).

The `app`, `tests` and `readiness` keys are in the table above.

## Verification keys: `verification`

Optional object; absent means `required: false`. Unknown keys inside it are errors.

The `verification` keys are in the table above.

`factory run` additionally refuses unless, on `origin/<base>`: `verification.required` is `true`; `readiness.min_level` is `4`; `local_checks` is `[]` (they would run outside the untrusted-code sandbox: run them in CI); `checks.required` does not name `factory/verified`; and `github.host` is the origin host. It merges only with `merge.mode: "squash"`. Verification also needs `app.start`, `app.base_url` with a port, and `app.ready` (a `ready.url` must use the same port). The app gets `HOST=127.0.0.1` and `PORT=<port>` and must listen on 127.0.0.1: a `localhost` base URL is contacted as 127.0.0.1. Full list: [factory-driver.md](factory-driver.md#refusals-at-start-factory-run).

Local run-control settings (`wait_for_reset`, `max_wait_h`, `max_wait_weekly_h`, `keep_awake`, `fallback_model`, `budgets.day_tokens`) live in `~/.factory/config.json`, not in this file: [run-control.md](run-control.md#config-reference).

<!-- config-schema:local:start -->
**local**

| Key | Meaning | Default |
|---|---|---|
| `wait_for_reset` | Wait for a usage limit to reset instead of stopping. Currently refused: the limit detector is only tested on fixtures, so true is an error. | `false` |
| `max_wait_h` | Longest wait in hours for a usage limit to reset. A longer reset stops the run instead of waiting. | `6` |
| `max_wait_weekly_h` | Longest wait in hours for a weekly usage limit to reset. 0 means a weekly limit always stops the run. | `0` |
| `keep_awake` | Keep the machine awake while a run is going. A sleeping laptop pauses the run and can break running sessions. | `true` |
| `fallback_model` | Model to switch to when the main model is out of quota. Empty means the run stops instead of switching. | `null` |
| `budgets.day_tokens` (sensitive) | Token cap per day across all runs on this machine. Empty means no daily cap. Raising it lets runs spend more in a day. | `null` |
<!-- config-schema:local:end -->

Environment for the factory driver: `FACTORY_HOME` (default `~/.factory`) holds scenarios, verdicts, the queue and the driver clone; `FACTORY_BUILDER_HOME` (default `<FACTORY_HOME>-builder`) holds the builder clone and must be outside `FACTORY_HOME`.

The queue file can be moved with the `DELIVER_QUEUE` environment variable (an absolute path; the folder is created with mode 0700 and a symlinked file or folder is refused). PR body files still live in `.delivery/`.

## Safety of the file itself
- It must be **committed and identical to the copy on `origin/<base>`** when a run starts, so the rules in force are the ones that were reviewed and merged. A local edit, or a copy that only exists on a feature branch, is refused.
- A feature that changes it is held for a person, and the run keeps using the policy it started with.
- `local_checks` commands run on your machine as you. They come from the reviewed base branch; read them as you would a CI script.
- Flags (`--base`, `--merge`, `--checks`, `--no-ci`, `--merge-t3`, `--features-dir`, `--max-fix-rounds`, `--max-failures`, `--ci-budget`) override the config for one run, **except** `protected_branches`, which only the file can change.
