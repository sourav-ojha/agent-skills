# Verification gate (factory Phase 1a)

A feature merges only when hidden scenarios the builder never saw pass against its running app, on the exact commit being merged. Phase 1a covers API scenarios; UI scenarios need the Phase 1b evaluator and are refused (below). The driver that runs all of this: [factory-driver.md](factory-driver.md). Spec: `docs/factory/specs/phase-1-verification-gate.md` in this repository.

Code: `core/scripts/lib/scenarios.mjs` (format, lint, approval), `core/scripts/lib/criteria.mjs` (criteria hash), `core/scripts/lib/verify.mjs` (verification run, symptom brief, `factory/verified`), `core/scripts/lib/apicheck.mjs` (API checks), `core/scripts/lib/verdict.mjs`, `core/scripts/lib/antigaming.mjs` (G1-G5), `core/scripts/lib/sandbox.mjs` (untrusted-code sandbox).

## Trust model

| Process | Trusted | Reads | Writes | Network |
|---|---|---|---|---|
| Driver (`factory run`, `deliver` as its subprocess; plain Node) | yes | what it needs | `FACTORY_HOME`, the driver clone, GitHub via `gh` | GitHub |
| LLM sessions: builder, scenario author (evaluator in 1b) | no | per role ([factory-driver.md](factory-driver.md#roles-and-sessions)) | per role | builder and author: none |
| Feature-branch code (the app, `app.setup`/`seed`/`start`/`stop`, build scripts) | no | its worktree, toolchains | its worktree and a per-run temp dir | setup: TCP 80/443 to any host; run: the app port on localhost only |

Rules the code enforces:
- Feature-branch code runs only inside `sandbox-exec` (macOS). No sandbox, no verification: there is no unsandboxed fallback.
- Policy comes from `.product/delivery.json` on `origin/<base>`, read with gitSafe. App commands come from that base config, never from the branch; the env example is read from the base ref, not the worktree.
- The driver's own git calls (factory.mjs, verification, anti-gaming) use gitSafe: neutralising `-c` flags (no hooks, fsmonitor, credential helper, pager, editor, gpg, ext/file transport, commit-graph), a repository-config allowlist, and a worktree walk that refuses nested `.git` entries, gitlinks and `.gitmodules`. **`deliver`'s own git is plain git** with the driver's environment; what protects it is the driver-clone preflight that runs before every `deliver` call ([factory-driver.md](factory-driver.md#layout)), plus gitSafe in `deliver merge`'s gate and changed-file list.

Design rule (not enforced by the code alone):
- The builder is meant never to see scenarios, verdicts or the canary. The driver gives it only criterion IDs and one fixed sentence (symptom brief), and keeps scenarios and verdicts under `FACTORY_HOME`, which the builder session's deny rules and sandbox are meant to keep out of reach. Whether those rules block every route is unverified: see [factory-driver.md known gaps](factory-driver.md#known-gaps) 1-6.

## Hidden scenarios

### Authoring: `factory scenarios`

`node <skill-dir>/core/scripts/factory.mjs scenarios [--only IDS] [--dir D] [--base B]` (details in [factory-driver.md](factory-driver.md#commands)). For each spec on `origin/<base>` with `status: ready` and `delivery` not `complete` (or each `--only` id), it:
1. extracts the criteria (`AC-n`, `EC-n`, `ER-n`) and the HTTP contract from the base spec, never the working tree;
2. skips a feature whose stored scenarios are current (reports "current and approved" or "awaiting approval");
3. otherwise runs one author session with `core/prompts/scenario-author.md`, a fresh canary and the extracted items as data;
4. accepts the reply only if it is exactly one JSON object `{"scenarios": [...]}` (one surrounding code fence tolerated, at most 1 MiB), lints it, and stores it.

Output is IDs, counts and lint problems only (problems name scenario IDs or indexes, never scenario text).

### File

`FACTORY_HOME/scenarios/<owner>__<repo>/<FEATURE-ID>.json`:

| Field | Meaning |
|---|---|
| `feature` | the feature id |
| `criteria_hash` | `sha256:` of the canonical base spec (below) |
| `canary` | `fx-` + 6 hex; must appear in some scenario's data |
| `scenarios` | `[{ id: "S-<n>", covers: [criterion IDs], kind: "api" \| "ui", ... }]` |
| `approved` | `{ by, at, scenarios_hash }`; not part of `scenarios_hash` |

API scenario: `setup` (optional array of requests), `request` `{ method, path, headers?, body? }`, `assert` (array). UI scenario: `setup?`, `steps`, `expect` (non-empty strings, max 500 chars each).

### Lint (`lintScenarios`)

Refused unless all hold:
- the base spec's criteria extract without errors and `criteria_hash` equals the current hash;
- the canary is well formed and appears in at least one scenario's `setup`, `request`, `steps` or `expect`;
- every `AC-n`, `EC-n`, `ER-n` is covered by 1 to 3 scenarios; no `covers` entry names an unknown or malformed ID;
- IDs are `S-<n>` and unique; `kind` is `api` or `ui`;
- an API scenario has `request` and a non-empty `assert`, its request and every setup request match an endpoint of the spec's HTTP contract (method and path, `{param}` segments match one non-empty segment without encoded `.`, `/` or `\`), every assertion is a recognised shape, **at least one assertion is `{ "status": <int> }`**, and no request or setup request uses a refused header or a body on `GET`/`HEAD` (below).

Assertion shapes: `{ status: 100-599 }`; `{ header, equals | matches }`; `{ json_path, equals | contains | not_contains | count | matches }`. An empty `contains` or `matches` is refused (vacuous).

### Approval and binding

`verification.scenario_approval`: `auto` stores the doc approved by `auto`; `human` stores it unapproved until `factory scenarios --approve ID --by NAME` (name: 1-64 of `A-Za-z0-9_.@-`). `--approve` re-lints first and approves only current scenarios; `--by auto` is refused. The mode is also enforced where the doc is used (`factory run`, verification, `deliver merge`'s gate): under `human`, a doc approved by `auto` is not approved.

`approved` is never trusted alone. At `factory run` start, on resume, and before each verification, the stored doc is **re-linted against the criteria on `origin/<base>` now**, and the approval must carry the doc's current `scenarios_hash` (`isCurrentApproved`). A base spec edit changes `criteria_hash`; any scenario edit changes `scenarios_hash`; either makes the feature refused until re-authored or re-approved.

### Rules for scenario authors

These follow from the lint and the checker (`apicheck.mjs`); the author prompt states the ones an author controls.
- **Every API scenario needs a status assertion.** An error response must not pass on body assertions alone.
- **Strict resolve.** `not_contains` and `count` fail when the `json_path` does not resolve on every step: a missing key, an out-of-range index, or `[*]` over a non-container. On a mixed array (some items lack the key) `$.items[*].name` does not resolve, so the assertion fails. `[*]` over an empty array resolves. `count` without `[*]` on a path that resolves to one array counts its items.
- Paths: `$`, `.key` (`[A-Za-z0-9_-]+`, not `__proto__`/`constructor`/`prototype`), `[n]`, `[*]`; at most 256 characters and 32 segments.
- `matches`: at most 256 characters, no flags, run in a worker with a 500 ms limit (a timeout makes the scenario `blocked`); subjects over 64 KiB fail.
- Requests, **refused by the lint**: the headers `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `Keep-Alive`, `Expect`, `Proxy-Authorization`, `Proxy-Connection`, `HTTP2-Settings`, any `proxy-*` or `sec-*` header (any case), and a body on `GET` or `HEAD`, in the request or a setup request.
- Requests, **blocked at run time** (the scenario is `blocked`, so the verdict fails; the lint does not catch these): a method that is not exactly upper-case `GET POST PUT PATCH DELETE HEAD OPTIONS`; a path that is not relative printable ASCII or has `//`, `\` or `#`; header names that are not tokens or values with control characters; more than 32 headers, 20 setup requests or 100 assertions; a body over 256 KiB; **a setup request answered with a status outside 2xx**. Redirects are not followed (the 3xx is the response).
- **The app must listen on 127.0.0.1.** Requests go to `http://127.0.0.1:<port>` even when `app.base_url` says `localhost` (so a process on `::1` cannot answer), and the `Host` header is therefore `127.0.0.1:<port>`. The app gets `HOST=127.0.0.1` and `PORT=<port>`.
- Each scenario has a 10 s budget for all its requests, body reads and regexes; bodies over 1 MiB are abandoned.

## Verification run (`verifyFeature`)

Started by the driver at `ci_passed`, for the commit CI passed (`ci_sha`), after it checked that no builder process survives. Needs `app.start`, a local `app.base_url` with a port, and `app.ready` (`url` on the same port, or `log_pattern`) in the base config.

1. A stored verdict for this sha with matching hashes and `pass` is reused (no run).
2. Refuses (throws) when: the sandbox is unavailable; the app port is in use on 127.0.0.1 or `::1`; the base ref or sha is missing in the driver clone; any scenario is `kind: ui` (1b); there are no API scenarios or more than 1000; `criteria_hash` is not current; a leftover worktree still has a live process.
3. `git worktree add` at `FACTORY_HOME/work/<repo-key>/<ID>-<sha>/`, from the driver clone.
4. Setup phase: `app.setup` in the sandbox (worktree and run temp writable; network TCP 80/443 to any host except localhost, plus name resolution, so LAN and cloud-metadata addresses stay reachable: known gap). A failed setup makes every scenario `blocked`.
5. Run phase, per scenario, twice: `app.seed`, `app.start`, wait for ready, run the scenario, then `app.stop` and a process-group kill. Network: the app port on localhost only. A failed seed, an app that never gets ready or dies mid-scenario makes that run `blocked`. Both runs must pass; disagreement is `fail` with `flaky: true`.
6. After every sandboxed phase, whatever its exit: nothing may listen on the app port (127.0.0.1 or `::1`) and no process may carry the worktree or run-temp path in its argv, environment (`ps -E`) or cwd (`lsof`). Otherwise the run is **escaped**: it throws, and the worktree and run temp are left in place with no git call on them.
7. Overall budget 7200 s, checked before every phase. Setup 900 s, seed 600 s, stop 30 s.
8. The verdict is written after the in-run survivor check that follows the last scenario. A final sweep then runs (port and survivors again); if it finds an escape, the just-written verdict is deleted (or, if that fails, overwritten as `fail` so it is never reused or posted) and the run throws. Otherwise the worktree is renamed into `FACTORY_HOME/trash/` and pruned, then deleted.

A throw means the driver holds the feature (`hold_kind: verification`); no fix round is used.

## Verdict file

`FACTORY_HOME/verdicts/<owner>__<repo>/<FEATURE-ID>.<sha>.json`, written only by the driver, exactly these 7 keys:

| Key | Value |
|---|---|
| `feature` | the feature id (must match the file name) |
| `sha` | 40-hex commit (must match the file name) |
| `scenarios_hash` | `sha256:` of the scenario doc without `approved` |
| `criteria_hash` | `sha256:` of the canonical base spec |
| `results` | 1-1000 of `{ id, covers, status: pass \| fail \| blocked, flaky }` |
| `verdict` | `pass` only when every result is `pass` and not flaky |
| `at` | ISO timestamp |

Reading is fail-closed: a symlinked dir or file, over 256 KiB, unknown keys, a mismatched feature or sha, or an inconsistent `pass` reads as no verdict. A verdict counts for a merge only when its `sha` is the PR head and both hashes equal values recomputed at that moment (`verdictMatches`).

## Symptom brief (what the builder sees)

Per failed or flaky scenario: `<covers IDs>: an endpoint returned an unexpected status or body`. A line that would contain the canary or any scenario string (4+ characters, from setup, request, assertions, steps, expectations, or request body/header keys) becomes `behaviour does not satisfy <IDs>`, or is dropped. No scenario IDs, paths or data. Lines are deduplicated, sorted by IDs, capped at 50.

## `factory/verified`

On a pass the driver re-reads the stored verdict, checks the PR head is still that sha, posts commit status `factory/verified` = `success` (description "Hidden verification scenarios passed on this commit"), confirms it is visible, and adds `Verified: N/N scenarios at <short sha>` to the PR body. Branch protection must require this status, so a merge by any other route is refused by GitHub. **A plain commit status can be posted by anyone with status write access**, the builder's shell included if it had a token; only a required check bound to an expected source (a GitHub App) prevents that. The verdict file, re-checked by `deliver merge`, is the real authority.

## Anti-gaming checks (G1-G5)

Computed from `git diff` between the merge base of `origin/<base>` and the head (no code executed, added lines only): by the driver at built, on the built head, and again by `deliver merge` on the PR head, which must equal `ci_sha` (the commit CI and verification ran on).

| Check | Fires when | At built | At merge |
|---|---|---|---|
| G1 | a test file present on the base is modified or deleted | PR opened, then held at `pr_open` | hold |
| G2 | skips or focused tests added (`.skip(`, `.only(`, `xit(`, `xdescribe(`, `@pytest.mark.skip`/`xfail`, `@Disabled`, `t.Skip(` and dodges) | one builder fix attempt, then block | hold |
| G3 | stub markers in non-test, non-doc code (`NotImplementedError`, `unimplemented!(`, `todo!(`, `throw new Error("not implemented")`) | one builder fix attempt, then block | hold |
| G4 | protected files: test, build and workspace config; in `package.json`, the scripts the configured test commands can reach, lifecycle scripts, test-runner and workspace keys, non-registry dependency specifiers; CI config, `.product/delivery.json`, the Claude Code project folder `.claude`, `.mcp.json`, agent memory files (any case), `.gitattributes`, `.gitmodules`, git hook managers, `__mocks__/` and `patches/` folders, committed dependencies (`node_modules/`, `vendor/`), `go.mod` replaces | PR opened, then held | hold |
| G5 | a spec's criteria, edge-case, failure or HTTP-contract text changed (any spec on the base, plus this one) | PR opened, then held | hold |

Test files: `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, anything under `__tests__/` or `tests/`, plus `verification.test_globs`. A git failure or unparsable output throws, and a throw is a hold, never clean. A held feature is released only by a person at an interactive terminal (stdin and stdout must be TTYs): `deliver retry ID --note "<why>"`, bound to the held sha and G-ids ([states.md](states.md)). Out of scope (the hidden scenarios are the backstop): semantic stubs, dynamically built skips, lockfiles, dependency files other than `package.json`; the full list is at the top of `antigaming.mjs`.

## Criteria hash

`criteria_hash` covers the **whole** base spec text, canonicalised (LF, no BOM, trailing spaces trimmed, blank-line runs collapsed), except two mutable regions: the frontmatter `status` and `delivery` lines, and a `## Delivery log` section that is the last block of the file (heading plus table rows to the end). Any other edit, prose included, changes the hash. Residuals: extra blank lines or trailing spaces inside a code block are not hashed. HTML or CSS inside delivery-log rows is not hashed either; in renderers that keep `<style>`, such CSS can change how **earlier** sections of the spec display, so read a spec's raw text, not its rendering, when reviewing criteria.

Extraction of the IDs and the contract (for the lint) is best effort: items hidden with HTML-block or comment tricks can be missed (a coverage gap, never a hash bypass). Specs over 256 KiB or with a line over 10,000 characters are refused before parsing.
