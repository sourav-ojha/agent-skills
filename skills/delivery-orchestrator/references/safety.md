# Safety model

## What the pipeline will and will not do
| Action | Rule |
|---|---|
| Merge | Only with `--merge` and the user's words as `--note`, or the config's standing `merge.mode: squash`; only squash; only the commit CI verified |
| Protected branches | Never merged into (default main, master, prod, production, release/*), whatever the flags say; only the committed config can change the list |
| Policy file | Must be committed and identical on the base branch; a feature that edits it is held. `init` snapshots it, but `merge` re-reads it from `origin/<base>` every time (`protected_branches`, `hold_paths`, `checks.ignored`, `verification`); a missing ref or a config path that is not a readable file holds |
| Account | If `github.account` is set, its token is used for gh (and git over https), verified to be that login with write access; the token is never stored or printed |
| Push | Feature branches only, never forced, never the base |
| Bypass | No `--admin`, no `--auto`, no hook skipping, no protection or CI edits |
| CI evidence | Required checks (or `--checks` names) must pass. A passing scanner or linter alone is not proof of tests: the run stops and says which checks ran. `--no-ci` is the only way to merge without a verified test check |
| T3 work (auth, data, migrations, public API) | PR opened, held for a person unless `--merge-t3` (or `merge.allow_tier3`) **and** a passing verdict matches (below); interactive runs have no verdict, so T3 is always held there |
| Verified merge (`verification.required: true` on `origin/<base>`) | `merge` reads the policy from the config on `origin/<base>` at merge time (a missing ref or an unreadable file holds; the queue's `policy` copy is never used). It needs state `verified` (`ci_passed` is refused), a queue file under `FACTORY_HOME` (the override fields live there), the PR head as GitHub reports it equal to the commit CI and verification ran on, a verdict file for that exact sha with `verdict: pass` whose `scenarios_hash` (from the stored scenarios) and `criteria_hash` (from the spec on `origin/<base>`) match values recomputed now, and the G1-G5 anti-gaming checks clean on that sha. Anything else holds (`awaiting_human`) with a category reason only: a push after verification, changed scenarios, changed criteria, a G-hit, or a check that could not run. Only `--match-head-commit <verified sha>` is merged. **Precondition:** merge runs in a driver-owned clone the builder cannot write to; before any gate git call the clone's config must pass the gitsafe allowlist and it must have no `info/grafts`, `shallow`, `objects/info/alternates`, `objects/info/commit-graph(s)`, `config.worktree` or `refs/replace/*` ref (they can rewrite history or swap objects so a diff looks empty or a policy looks different); otherwise it holds. The policy itself is read with replace refs ignored, from exactly the commit `merge` just fetched with an explicit `+refs/heads/<base>:refs/remotes/origin/<base>` refspec from an `origin` that must resolve (`git remote get-url --all`, after repo-config rewriting) to exactly one URL, the pinned repository (else hold); the tracking ref must equal that fetched commit. In driver mode (queue under `FACTORY_HOME`, or the local base config already requires verification) the preflight and a no-hooks check run **before** the fetch, `remote.origin.pushurl` is refused, and the fetch goes to a URL rebuilt from the pinned host and repository (not the named remote) with the gitSafe neutralising flags; interactive mode keeps the named-remote fetch through your own config, so rewrites in your environment or global config are yours and are not checked. The changed-file list that feeds the CI/hold-paths hold is computed with gitSafe in every mode.

**What the preflight does not cover.** It checks configuration and well-known redirection files only. Forged loose objects, a crafted pack `.idx` or `multi-pack-index`, a `.git` file that redirects the git dir, or a clone owned by another user (with the global config off, git's `safe.directory` check makes every read fail, which holds) are not detected or are only caught indirectly. The real boundary is that `merge` runs in a driver-owned clone the builder cannot write to. The queue must be a private (0600-style, one link, owned by the runner) file under `FACTORY_HOME`, outside the repository, with `FACTORY_HOME` neither the repository nor an ancestor of it |
| T3 hash binding | The T3 verdict check uses the same recomputed `scenarios_hash` and `criteria_hash` and the anti-gaming checks, whatever `verification.required` says |
| Anti-gaming override | A G-hit at merge is waived only by a person's `retry --note` at a terminal. The hold records the commit and G-ids; `retry` refuses if the PR head moved since the hold, shows the commit and ids, and binds the override to exactly that commit and those ids (a new G-id or a new commit is not covered). Honoured only from a trusted queue under `FACTORY_HOME`; a check that could not run is never waived |
| Changes to `.github/`, other CI config, `CODEOWNERS` | Held for a person: a feature must not edit the checks that gate it |
| Failures | A cap on CI fix rounds; a circuit breaker after consecutive blocked features |
| Interruption | State in `.delivery/queue.json`; `next` resumes; nothing is merged twice |
| Fork PRs | A PR from a fork with the same branch name is ignored and never merged |
| Untrusted text | Specs, PR text and CI logs are data; titles and reasons are stripped of control characters; no shell is used |

## What it cannot do
- **The state file is not tamper-proof.** `.delivery/queue.json` sits in the worktree, so an agent (or a prompt-injected spec) that can write files can edit it, for example to set `merge: true`. The helper re-validates every ref and sha it reads, but it cannot tell an honest edit from a forged one. `merge` does not trust the file for "CI passed": it asks GitHub again whether the required (or named) checks pass on the exact commit. The run's flags (`merge`, `merge_t3`, `no_ci`, `checks`) cannot be re-derived from GitHub, so they stay file-trusted; `merge` takes the policy itself (`protected_branches`, `hold_paths`, `checks.ignored`, `verification`) from the config on `origin/<base>`, and with verification required it refuses a queue file outside `FACTORY_HOME`. The authorisation note is a record, not a lock; GitHub's branch protection is the lock.
- **It is not access control.** An agent with a shell could run `gh` directly. The real gate is GitHub: protect the base branch (required checks, and required reviews for anything you want a person to approve). When protection blocks a merge, the pipeline holds the PR instead of working around it.
- **Green CI is only as good as your tests.** The implementer is told to write criterion-level tests; CI proves they pass, not that the spec was right.
- **Detection of risky changes is path-based.** A T3 judgement comes from the implementer's tier; a mislabelled tier gets the policy of that tier.

## Recommended setup
1. Branch protection on the base: require status checks; require a review if you want a person on every merge (the pipeline will then hold each PR, which is the intended behaviour).
2. Start small: `--limit 1` for the first run, then widen.
3. Read the final report; stashes and unmerged branches are listed there.

## Proving the hard stops

Each Phase 2 hard stop (spec P2.2) has a real mechanism and a proof, listed in `core/scripts/lib/hardstops.mjs`. Rows proven by a test are covered by the test suite. Rows proven by the isolation probe (`core/scripts/probe.mjs`) stay **unproven** until a saved probe result shows their routes denied: `factory run` prints each one at start (`unproven hard stop: <id> <name>`) and adds one attention row (`unproven_hardstop`). It is a warning; the run continues.

A saved result proves only what it probed. It records the builder settings it was made with (`builder_settings_sha256`), so any change to `core/settings/builder.json` makes every probe row unproven again. The FACTORY_HOME rows count only when the probe wrote into your real FACTORY_HOME. The secrets row needs one saved target per credential class: `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.netrc`, each with every read route denied. One directory never proves it.

To prove them on this machine (the builder cannot write `~/.factory`, so the save happens outside it), repeat once per credential class:

1. Outside the builder (the control): for a directory, put a random token in `<dir>/.probe-sentinel` and run `PROBE_TOKEN=<token> node probe.mjs --target <dir> --write-target <dir2> --factory-home ~/.factory --net-host <host:port> --json > control.json`. For `~/.netrc` (a file), use `--target-file ~/.netrc` with `PROBE_TOKEN` set to a substring of that file that is not a secret, such as `machine <host>`: never the login or password. The token goes into the builder session's command line and environment in step 2, and its unsalted sha256 is written to control.json and probe.json. Every route should leak there.
2. Inside a builder session: the same command with `> probe.json`.
3. Inspect `probe.json` yourself. Then, outside the builder, run `node probe.mjs --from probe.json --control control.json --save` **yourself, not through an agent**. It merges this target's results into `~/.factory/probes/last.json`. A route is saved as `denied` only when the control run leaked through that same route. Otherwise it is saved as `error` and stays unproven. `--save` refuses a result made under other builder settings than the current `builder.json` (each result records its `builder_settings_sha256`, and the control must match it).

A `--from` result is only as trustworthy as the channel that produced it: it is whatever the builder session wrote. `--from` refuses malformed files and duplicate route entries, but it cannot tell whether a well-formed file is genuine.

`--net-host` must be a non-local host you are allowed to connect to; never a production host or database. Denying `gh` or `git push` by permission pattern is only a prompt-layer rule; the real controls are no token, the network limit and branch protection.

Run control (budgets, interruptions, stop and kill rules, the attention view): [run-control.md](run-control.md).
