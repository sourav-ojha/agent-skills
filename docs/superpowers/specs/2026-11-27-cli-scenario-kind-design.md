# CLI scenarios for factory verification — design

Status: draft for review, 2026-11-27.
Scope: `skills/delivery-orchestrator`, which covers hidden scenarios, the lint, the verifier and the author prompt. The intake spec contract in `skills/feature-intake` also changes.

## Why

The factory merges a feature only after hidden scenarios pass against the exact PR head. Today the verifier runs only `api` scenarios: an HTTP request against a running app. The first real benchmark (`sourav-ojha/seo-bench-scratch`, FEATURE-008 `seo about`) got through scenarios, build, PR, the G1 hold and CI. It then stopped at verification. The feature is a CLI, the author wrote `ui` scenarios, and the verifier refuses those until Phase 1b.

Most of the user's projects are command-line tools, and most of those exist to write files: the skill helpers write under `.product/`, and `seo init` writes a config. A CLI scenario therefore has to check what the command printed and exited with, and also what it left on disk. The user chose "output plus files" and asked for it inside the existing verifier.

## Goals

- A new scenario kind, `cli`, that the existing verifier runs. It reuses the worktree, sandbox, run-twice, survivor and escape checks, verdict file, `factory/verified` posting and merge gate unchanged.
- **Exit code checks**, required on every scenario, as `status` is for `api`.
- **Output checks** on stdout and stderr.
- **File checks** on files the command wrote.
- **Spec binding:** a `## CLI contract` section in the spec. Every scenario's command must match one of its entries, in the same way an API request must match the HTTP contract.
- **Fixed program:** the program under test is fixed by the reviewed base config (`app.cli`). Scenarios supply only arguments, stdin and setup files.
- **Early warning:** `factory scenarios` reports a stored scenario set that the verifier cannot run yet (`ui`-only, or kinds the config cannot support) as `unverifiable`. Today it says nothing and the run fails at the end.

## Non-goals

- UI scenarios. Those stay Phase 1b.
- Network access for the command under test.
- Interactive commands (TTY, prompts). `stdin` is a fixed string, and there is no terminal.
- Checking files outside the scenario's own working folder, or binary file contents.
- Mixing `cli` and `api` in one feature. A feature's scenarios are all `api` or all `cli` in this phase. See "Left open".

## Anti-goals

These would make the change a failure even if it works:

- **A scenario or PR choosing the program that runs.** That includes a shell string, an absolute path, or a different interpreter.
- **A file check that reads outside the scenario folder.** That includes `..`, absolute paths, and symlinks the command created that point outside.
- **A weaker verdict.** Every existing rule stays: run twice, survivor scan, escape handling, verdict binding to sha and hashes, and approval binding.
- **Builder visibility.** Scenarios stay hidden; the builder never sees them.

## Approaches

1. **A `cli` kind inside the existing verifier (chosen).** A new `clicheck.mjs` beside `apicheck.mjs` runs one scenario. `verifyFeature` picks the runner by kind. Everything safety-critical is reused.
2. **A separate CLI verifier.** It is simpler to read alone, but it duplicates the worktree, sandbox, escape and verdict code, which is the code most likely to drift into a hole. Rejected.
3. **Scenarios as full shell commands.** These are the most flexible, but the author or the PR could run anything. That breaks the fixed-program anti-goal. Rejected.

## Design

### Config: `app.cli`

New key in `.product/delivery.json`, read from `origin/<base>` like every other key:

```json
"app": { "cli": { "command": ["node", "./node_modules/tsx/dist/cli.mjs", "./src/cli.ts"], "timeout_s": 30 } }
```

- **`command`:** an argument list of 1 to 10 strings, never a shell string. An element starting with `./` is resolved against the verification worktree, so the PR's code runs, while the base config decides which entry point and interpreter. Any other element is used as written, for example `node` from the sandbox PATH. Absolute paths, `..` segments, and `./` paths that escape the worktree after resolution are refused.
- **`timeout_s`:** per command invocation, 1 to 120, default 30.
- **Requirement:** `app.cli` is required when any stored scenario is `cli`. `app.start`, `app.base_url` and `app.ready` are then not required. `app.setup` still runs once per verification, for installs.
- **Sensitivity:** in the config wizard schema `app.cli` is an argv key and therefore sensitive, like `app.start`. Readiness level 4 accepts `app.cli` in place of a startable app. C6 to C8 are skipped when only `app.cli` is set, and a new check C9 replaces them (below).

### Spec: `## CLI contract`

An optional section, parsed like `## HTTP contract`. Each bullet is one backticked command pattern:

```
## CLI contract

- `seo about`
- `seo about --json`
- `seo init`
```

- The first word is the program's display name and is ignored when matching, because `app.cli.command` decides the program. The remaining words are literal argument words.
- **Placeholders:** `<name>` stands for exactly one argument. A trailing `...` allows any further arguments.
- **Matching:** a scenario's `args` must match one pattern, word for word, with placeholders matching one non-empty argument.
- **Hash:** the section is part of the canonical spec, so `criteria_hash` covers it. Editing the contract invalidates stored scenarios, as the HTTP contract does now.
- **Intake:** feature-intake's spec template gains the optional section, and its readiness check accepts it.

### Scenario shape (`kind: "cli"`)

```json
{
  "id": "S-1", "covers": ["AC-1"], "kind": "cli",
  "setup": { "files": [{ "path": "sites/x.yaml", "text": "..." }], "runs": [{ "args": ["init"] }] },
  "run": { "args": ["about", "--json"], "stdin": "" },
  "assert": [
    { "exit": 0 },
    { "stdout": { "json_path": "$.name", "equals": "seo-workflow-orchestrator" } },
    { "stderr": { "equals": "" } },
    { "file": "seo.config.yaml", "exists": true },
    { "file": "out/report.json", "json_path": "$.items", "count": 3 }
  ]
}
```

- **`run.args`:** 0 to 64 strings, each up to 4096 characters, no NUL. They must match the CLI contract. **`run.stdin`:** an optional string up to 64 KiB.
- **`setup.files`:** up to 50 entries of `{path, text}`, each text up to 256 KiB. The path rules are the same as for file assertions, below. Files are written before any run.
- **`setup.runs`:** up to 10 earlier invocations of the same program, each `{args, stdin?}`, each bound to the contract. A non-zero exit makes the scenario `blocked`, as a failed API setup request does.
- **Assertions:** at most 100 per scenario.
  - `{ exit: 0..255 }`. At least one is required.
  - `{ stdout | stderr: <text-check> }`, where a text check is one of:
    - `equals`, `contains`, `not_contains` or `matches` on the whole stream;
    - `json_path` with `equals`, `contains`, `not_contains`, `count` or `matches`, parsing the stream as JSON. A stream that does not parse fails the assertion.
  - `{ file: <path>, exists: true|false }`.
  - `{ file: <path>, <text-check> }` on the file's contents as UTF-8.
- **Shared rules:** the path, regex and `json_path` rules are the same as for `api`: same limits, same strict resolve, same 500 ms regex worker, and an empty `contains` or `matches` is refused.
- **File paths:** relative, forward slashes, no `..` segment, no leading `/`, no NUL, at most 256 characters. After the run, each assertion's path is resolved with `realpath` and must stay inside the case folder. A symlink pointing outside fails the assertion; it is never followed to read. Contents over 1 MiB fail.

### How a verification runs a `cli` scenario

The steps of `verifyFeature` stay the same: stored verdict reuse, refusals, worktree, setup phase, two runs per scenario, survivor checks, verdict, final sweep. The run phase for a `cli` scenario changes:

1. **Case folder.** Make a fresh run temp for this run of this scenario, with its own empty case folder, `HOME` and `TMPDIR` inside it. An earlier run's folders are not reachable from a later run. It is the command's working directory and the only writable place besides the run temp. The worktree is read-only during the run phase. This is a change from `api`, where the worktree stays writable. A command that writes into its own source tree fails, which is the honest result.
2. **Setup.** Write `setup.files` into the case folder, then run `setup.runs` in order.
3. **The command.** Run `app.cli.command` + `run.args` through `runSandboxed`:
   - working directory: the case folder;
   - `HOME` and `TMPDIR`: inside the run temp;
   - environment: the existing `allowEnv` set from `app.env_example`, plus `CI=1` and `NO_COLOR=1`;
   - stdin: the given string, then closed;
   - network: none (a new `network: 'none'` profile option);
   - timeout: `app.cli.timeout_s`;
   - capture: stdout and stderr up to 1 MiB each. More than that blocks the scenario.
4. **Check.** Evaluate the assertions. A timeout, a spawn failure or an over-size stream makes the run `blocked`.
5. **Kill.** Kill the process group. The existing after-phase survivor check then runs, but the port check is skipped, since a CLI has no port.

Both runs must pass, and disagreement is `fail` with `flaky: true`, as today. The two runs use separate case folders, so state never carries over.

### Refusals that change

- "Any scenario is `kind: ui`" stays a refusal.
- "No api scenarios" becomes "no runnable scenarios".
- A mix of `api` and `cli` scenarios is refused in this phase.
- A `cli` set without `app.cli`, or an `api` set without `app.start`/`app.ready`, is refused before any worktree is made.

### Lint (`lintScenarios`)

- `kind` may be `api`, `ui` or `cli`.
- A `cli` scenario needs `run` and a non-empty `assert` with at least one `exit`. Every assertion must be a recognised shape.
- `run.args` and every `setup.runs[].args` must match the spec's CLI contract, and a spec with no CLI contract refuses every `cli` scenario.
- File paths and sizes must follow the rules above.
- The canary rule extends to `run`, `setup` and `assert` string values.

### Authoring and the early warning

- **Author prompt:** the scenario-author prompt learns the `cli` shape. It uses `cli` when the spec has a CLI contract and no HTTP contract, `api` for the reverse, and `ui` only when the spec has neither.
- **New outcome:** `factory scenarios` gains an outcome per feature, `stored, unverifiable (<why>)`, reported when the stored set has `ui` scenarios, mixes kinds, or needs `app.cli`/`app.start` that the base config lacks. It is counted as `unverifiable` in the summary line. The scenarios are still stored, because they become runnable when Phase 1b or a config fix arrives.
- **Early refusal:** `factory run` refuses at start with a `fix:` line when a picked feature's set is unverifiable, instead of building it and holding it at `ci_passed`. The whole run refuses (exit 1), as it already does for a feature without current approved scenarios. Use `--only` to run the other features.
- **Both contracts:** a spec with both an HTTP contract and a CLI contract is reported `unverifiable (mixed contracts)` in this phase. The author prompt writes `api` scenarios for it, and feature-intake's check warns about the combination.

### Readiness C9

A new check at level 4: "CLI runs". It runs the same way C6 to C8 run today: in a temp worktree of the base tip, through the readiness command runner, with the allowlisted environment and not sandboxed, because readiness runs only reviewed base code. It runs `app.setup`, then `app.cli.command` with no arguments, in an empty case folder with no network. It passes when the process exits within `timeout_s`, with any exit code, and leaves no survivor. The aim is to prove the program starts under the sandbox, not that it behaves.

- **When `app.cli` is set and `app.start` is not:** C6 to C8 are skipped and C9 decides level 4.
- **When both are set:** all of C6 to C9 must pass.

### Symptom briefs

A failing `cli` scenario uses the existing `symptomBrief`. That brief gives the criterion IDs and one fixed sentence per failure, and it drops any line that contains a scenario string. The brief adds only the failed family, one of the fixed words `exit`, `stdout`, `stderr`, `file`, `run` or `setup`. `verifyFeature` returns the words as `families` (not stored in the verdict, which keeps its 7 keys) and the driver puts them in the fix brief. It never includes program output, args or expected values, because output often repeats the expected values.

## Constraints

- Zero dependencies, Node ≥ 22, ESM. The existing seams pattern (`seams.*`) is kept for tests, and the tests use the fake sandbox runner where the API tests already do.
- **Sandbox:** the macOS `sandbox-exec` profile gains a no-network option. There is still no unsandboxed fallback.
- **Output policy unchanged:** terminal lines carry states, IDs and counts only.
- **Verdict file keys:** unchanged, still 7. The scenario kind is recorded through `scenarios_hash`.
- **Bench:** FEATURE-008 on `seo-bench-scratch` must go from `awaiting_human (verification)` to merged after re-authoring. That is the acceptance run.

## Decided with the user

- CLI scenarios check output and files: answer (b).
- The kind is built inside the existing verifier: approach 1.

## My calls (correct any)

- Scenarios supply only arguments. The base config fixes the program, and `./` paths resolve into the worktree.
- Each run gets a fresh, empty case folder as its working directory, and the worktree is read-only during runs.
- There is no network for the command under test.
- `api` and `cli` are not mixed in one feature in this phase.
- The CLI contract's first word is a display name, ignored when matching.
- Readiness C9 is a smoke start, not a behaviour test. It runs unsandboxed, like C6 to C8. A skipped C6 to C8 does not lower the level when C9 passes and only `app.cli` is set.
- Symptom briefs keep today's fixed sentences and never show program output.
- An unverifiable feature refuses the whole `factory run`, as a feature with no approved scenarios does now.
- A spec with both contracts is unverifiable in this phase.
- `network: 'none'` already exists in `sandbox.mjs` and is reused.
- `factory run` refuses unverifiable features at start rather than building them.

## Left to the builder

- **Module layout:** `clicheck.mjs` beside `apicheck.mjs` is suggested, along with how the existing text and `json_path` checks are shared between them.
- **The sandbox profile change** for `network: 'none'`.
- **Exact error and limit wording**, which follows the existing style.
- **The order of implementation tasks.**
