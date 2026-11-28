# Guide: delivery-orchestrator

Takes every ready feature spec and delivers them one by one without you: **branch → [implementer](implementer.md) → PR → wait for CI → squash merge → next**. It is the hands-off end of the pipeline that starts with [product-intelligence](product-intelligence.md).

## When to use it
- You have several specs with `status: ready` (what product-intelligence `handoff` writes, or a [feature-intake](feature-intake.md) spec after you approved it) and want them built, reviewed by CI and merged without babysitting.
- Not for: one feature you want to watch (use [implementer](implementer.md)), or designs that are still open (see [build-workflow](build-workflow.md)).

## Before you start
- The GitHub CLI is logged in (`gh auth status`) and the repo has a GitHub remote.
- Both skills are installed: `npx skills add sourav-ojha/agent-skills --skill delivery-orchestrator -a claude-code` and `--skill implementer`.
- **The repo has CI that runs your tests**, and the base branch ideally *requires* it (branch protection). If the only checks that ran are a linter or secret scanner, the run stops and tells you which checks it saw: pass `--checks "<your test check>"`. (`--no-ci` accepts the implementer's local test evidence instead; it is never implied.)
- Ideally the base branch is protected (required checks, and required reviews where you want a person). That, not this skill, is the real gate.

## One-time project setup
```bash
node <skill-dir>/core/scripts/deliver.mjs config --write      # creates .product/delivery.json
```
Edit it, commit it and merge it to your base branch. The main settings:

| Setting | What it controls |
|---|---|
| `github.account` | Which `gh` login to use if you have several |
| `base` | The branch features start from (always its latest tip) and PRs and merges go to |
| `protected_branches` | Branches it will **never** merge into (default `main`, `master`, `prod`, `production`, `release/*`) |
| `merge.mode` | `pr-only` (default) or `squash` (standing permission to merge) |
| `checks.required` / `checks.ignored` | Which CI checks must pass, and which to ignore (for example `e2e*` if the project has no real e2e) |
| `local_checks` | Commands it runs itself before opening a PR, such as `["npm","test"]` |
| `hold_paths` | Paths a person must review before merge, such as `migrations/` |
| `implementer_notes` | A line passed to the implementer, such as "unit and integration tests only" |

Full reference: [`references/config.md`](../../skills/delivery-orchestrator/references/config.md). Note the default: a repo whose base branch is `main` is treated as protected, so it opens PRs but does not merge until you pick a non-protected base (usually `develop`) or deliberately list your own `protected_branches`.

## Editing the config
Every command below works on `.product/delivery.json`. Add `--local` to `explain`, `set`, `unset`, `init` or `edit` for the per-machine `~/.factory/config.json`; the one exception is `edit --profile factory`, which edits the project file only. None of them runs git: commit the project file and merge it to the base branch yourself.

```bash
deliver config explain --list              # every key, one line each
deliver config explain autonomy.level      # type, allowed values, default, what it does, which rule reads it
deliver config init --from-draft draft.json   # create the file (needs a terminal)
deliver config edit [key|group]            # change values with prompts (needs a terminal)
deliver config edit --profile factory      # only the keys factory run needs, then a checklist
deliver config set base develop            # one change, no prompts; the value is JSON
deliver config unset hold_paths
```

**Let an AI draft it.** The wizard does not read your repository, so it cannot find your test command, port or CI check names. Ask your AI assistant: "Read this repo (package files, CI workflows, README). Write `draft.json` with the `.product/delivery.json` keys that apply (the file allows no extra keys), and tell me in your reply which file and line each value came from. Do not guess a value you cannot point to. Then tell me to run `deliver config init --from-draft draft.json`." (`init` needs a terminal, so you run it, not the assistant.) `init` shows the draft, walks the keys that fail validation first, shows a diff and asks before writing. Check the evidence yourself before you type `y`.

**What needs a person.** Changes that widen what runs unattended or weaken a gate (merging with `L1`, `merge.allow_tier3`, `checks.allow_without_ci`, fewer `protected_branches` or `hold_paths`, `local_checks`, the commands in `app.*` and `tests.*`, fewer `checks.required` or a named list where it was empty, higher `budgets`) need you to type `yes` at a terminal, once per key, also when the value came from a draft. So does any change to a sensitive key whose current value is invalid, because the parser then uses a substitute and the change cannot be judged. `set` and `unset` will not loosen a rule unless a person confirms at a terminal. `init` and `edit` always need a terminal.

This is a guardrail for agents that have no terminal, not a security boundary: a pseudo-terminal can satisfy the terminal check, and an agent can edit the JSON file directly. The real control is that `.product/delivery.json` must be committed and identical to `origin/<base>` before a run, so a person reviews the diff when it is merged. `--local` (`~/.factory/config.json`) has no commit step, so nobody reviews a change to it.

Not everything is gated by `set`: removing the `readiness` block or lowering `readiness.min_level` is not, because `factory run` enforces level 4 itself and the change shows up in the config diff a person reviews.

Answering anything other than `yes`: during the walk it keeps the old value and the walk goes on (exit 0 if you then write or quit). At the final gate, for values that came from a draft or were already in the file, it stops: the command exits 1 naming the key, and nothing is written.

`deliver config` still shows the effective values and errors. The parser decides what is valid; the wizard only runs it on the candidate file before writing.

## Start small
```
/delivery-orchestrator --dry-run        # show the queue, change nothing
/delivery-orchestrator --limit 1        # one feature, PR only, no merge
/delivery-orchestrator --merge          # authorise squash merges for the queue
```
In plain words: "deliver all the ready features and merge each when CI is green". It passes `--merge` only if you asked it to merge, and records your words.

## What happens for each feature
1. The base branch is updated and `feat/<id>-<slug>` is created.
2. The implementer builds it (`--unattended`: nothing waits for you; a question only a person can answer ends that feature as `BLOCKED`).
3. A PR is opened (pushed without force).
4. It waits for CI. A failing check gets up to 2 fix rounds (test first), then the feature is blocked.
5. It squash-merges **the exact commit CI verified** and syncs the base.
6. Next feature. A feature whose dependency did not merge is skipped, not built on a missing base.

Order: `depends_on: FEATURE-001, FEATURE-002` in a spec's frontmatter, then by id.

## What it holds for you instead of merging
- T3 work (auth, data, migrations, public API) unless you pass `--merge-t3`.
- Any change touching `.github/`, other CI config or `CODEOWNERS`.
- Anything branch protection or a required review blocks.
- All of it if you did not pass `--merge`.

It also stops the whole run on: no verified test check (see above), two blocked features in a row, a base branch that cannot be fast-forwarded.

## Readiness
Before letting a repo run unattended, check it: `node <skill-dir>/core/scripts/deliver.mjs readiness` (add `--repeat 2` to catch flaky checks, `--json` for machine output). It runs your declared test and app commands in a throwaway worktree and gives a level:

| Level | Meaning |
|---|---|
| 0 | Not configured |
| 1 | Config committed, tools ready |
| 2 | Tests run from a clean checkout, no tracked secrets |
| 3 | CI gate trustworthy: safe to merge on green |
| 4 | App starts, logs and seeds from a clean checkout; or, for a command-line tool with `app.cli`, the command runs from a clean checkout (check C9) |

Each failing check comes with a fix item. The result is stored in `~/.factory/readiness/`, outside your repo. To enforce it, add `"readiness": {"min_level": 3, "max_age_days": 14}` to `.product/delivery.json`: a run that may merge then refuses to start without a fresh result at that level. Without that key nothing changes. Each feature outcome is also logged to `.skill-runs/factory-runs.jsonl`; `si runs-factory` adds token cost. Details: [`references/readiness.md`](../../skills/delivery-orchestrator/references/readiness.md).

## Verified delivery: the factory driver
For merges proven by checks the builder can neither see nor edit, run the factory driver yourself, from a checkout of the repo (macOS; it needs `sandbox-exec`):
```bash
node <skill-dir>/core/scripts/factory.mjs scenarios              # hidden scenarios for every ready spec
node <skill-dir>/core/scripts/factory.mjs scenarios --approve FEATURE-001 --by you   # only with scenario_approval: human
node <skill-dir>/core/scripts/factory.mjs run [--only IDS] [--limit N]
```
It works in its own clones (`~/.factory/clones/<owner>__<repo>` for itself, `~/.factory-builder/<owner>__<repo>` for the builder), so your checkout is never touched. Each feature: builder session, anti-gaming checks, PR, CI, then the hidden API scenarios run twice against the app built from the exact PR head, in a sandbox. A pass posts the `factory/verified` status and merges that commit; a fail sends the builder criterion IDs only and uses a fix round. Exit `0` done, `1` refused (it prints what to fix), `2` stopped or a feature needs you; run it again to resume.

It refuses to start unless `.product/delivery.json` on the base says `"verification": {"required": true}`, `"readiness": {"min_level": 4}` and `"local_checks": []`, a level-4 readiness result is stored, branch protection requires the `factory/verified` status, and every picked feature has current approved scenarios. Your user Claude Code `settings.json` may hold only allowlisted keys (`$schema`, `model`, `cleanupPeriodDays`, `includeCoAuthoredBy`, a few telemetry and timeout `env` names, `permissions.deny`, and `enabledPlugins` and `sandbox` only when empty); any other key, hooks, a status line or plugins included, refuses every session. **Command-line projects.** A feature whose spec has a `## CLI contract` is verified with `cli` scenarios: set `app.cli` (`{"command": ["node", "./src/cli.ts"], "timeout_s": 30}`) instead of `app.start`, `app.base_url` and `app.ready`. Scenarios run the fixed command with their own arguments in an empty folder with no network, and check the exit code, output and files it wrote. `factory scenarios` reports a stored set the verifier cannot run as `unverifiable (<why>)`, and `factory run` refuses to start while a picked feature is unverifiable. See the `cli` section of [`references/verification.md`](../../skills/delivery-orchestrator/references/verification.md#cli-scenarios).

Details and known gaps: [`references/factory-driver.md`](../../skills/delivery-orchestrator/references/factory-driver.md), [`references/verification.md`](../../skills/delivery-orchestrator/references/verification.md).

## Running unattended: limits, stop, continue
`factory run` is built to be left alone. Set the rules, start it, check in with `status`:

- **Autonomy.** `"autonomy": {"level": "L0"}` opens PRs and merges nothing; `"L1"` merges on green. With an explicit L0, `--merge` is ignored.
- **Budgets.** `"budgets": {"feature": {"tokens": 3000000, "turns": 400}}` in `.product/delivery.json` caps each feature (these are the defaults). A feature that reaches its cap is held with its work committed and the run carries on with the next one; release it with `factory run --raise-budget FEATURE-001` (adds the policy caps again; the first raise doubles them) or `--raise-budget FEATURE-001=6000000` (sets the token cap). For a cap per day across all your repos, put `{"budgets": {"day_tokens": 30000000}}` in `~/.factory/config.json`; without it `factory run` warns.
- **Usage limits.** A session that hits a limit is not a failure: the driver commits the work as `wip(<ID>): interrupted (<kind>)` and stops, and `factory run --continue` carries on from there with a continue brief. Waiting for a session limit to reset by itself (`wait_for_reset`, `max_wait_h`, ...; also a day-cap wait) is switched off until the limit detector has been checked against a real limit event; see [`references/run-control.md`](../../skills/delivery-orchestrator/references/run-control.md#wait_for_reset-and-the-classifier).
- **Stop.** `factory stop` interrupts a running session within about 5 seconds (and a wait within 30) and ends the run at the next step; it does not cut the CI wait short (`--now` does; a verification already running finishes). Weekly waiting needs `max_wait_weekly_h` > 0 AND `wait_for_reset`. `factory run --continue` resumes the same run. Plain `factory run` refuses while a stop is pending; `factory scenarios` clears a stop left with no run active.
- **Status.** `factory status [--json]` shows the run, each feature's usage against its cap, the next resume time and what needs you; the same list (blocked and held features, budget holds, stops, scenarios waiting for approval, each with the command to run) is in `~/.factory/attention/<owner>__<repo>.md`. A `paused` notification is sent on every pause, retries included. macOS notifications say only the repo, the event and a count.

While a run is live or a stop is pending, interactive `deliver` commands refuse. `factory run` prints which hard-stop checks are still unproven on this machine; the probe steps are in [`references/safety.md`](../../skills/delivery-orchestrator/references/safety.md#proving-the-hard-stops).

## What you get
A final report: merged features (PR and sha), PRs waiting for you (and why), blocked or skipped features (and where the partial work is: a branch plus `git stash list`), and non-code follow-ups from the specs' delivery logs.

## Interrupted? Resume
State is in `.delivery/queue.json`. Say "continue the delivery run" in any session: it resumes the active feature. `deliver status` shows everything.

## Combine with
- **[product-intelligence](product-intelligence.md)** upstream (specs); **[implementer](implementer.md)** does the coding; **[review-and-quality](review-and-quality.md)** for a deeper review of any held PR (`/deep-pr-review`); **[skill-insights](skill-insights.md)** to see what a long run cost.

Safety model and its limits: [`references/safety.md`](../../skills/delivery-orchestrator/references/safety.md). State machine: [`references/states.md`](../../skills/delivery-orchestrator/references/states.md).
