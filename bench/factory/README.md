# Factory benchmark (Phase 1a, API)

The fixture product and runner for the Phase 1a exit criteria in
[docs/factory/specs/phase-1-verification-gate.md](../../docs/factory/specs/phase-1-verification-gate.md) (P1.5).

| Path | What it is |
|---|---|
| `app/` | The base product: a small task-list JSON API (`src/`), its unit tests, `.product/delivery.json` and 14 feature specs (`.product/features/FEATURE-001..014.md`) with AC/EC/ER IDs and an HTTP contract. No feature is implemented yet. |
| `cases/` | One patch per case against `app/`, listed in `cases/cases.json` with its set (`tuning` / `heldout`) and category. FEATURE-001..004 belong to the tuning set and FEATURE-005..014 to the held-out set; the two sets share no feature. |
| `scenarios/` | **The real scenarios.** Not in the repository until you author them (below). One `FEATURE-<n>.json` per feature. |
| `scenarios-fixture/` | **Test-only** hand-written scenarios used by `tests/validation/factory-bench.test.mjs`. They are not the authored benchmark set: `run.mjs` refuses them as stored scenarios and uses them only with `--fixture`. |
| `run.mjs` | The runner. |

Cases per set (API rows of the P1.5 table):

| Category | Tuning | Held-out |
|---|---|---|
| good | 4 | 10 |
| stub | 2 | 6 |
| wrong behaviour | 2 | 6 |
| edge | 2 | 6 |
| test edit | 1 | 3 |
| snooping app | 0 | 1 |
| listener | 0 | 1 |
| config injection | 0 | 1 |

## Authoring the scenarios

Do this once, with a real author session (Task 14 of the Phase 1a plan):

1. Make `app/` the root of its own GitHub repository (default branch `main`) and set up the factory for it as for any repo (`github`, `merge`, `checks` in `.product/delivery.json`, readiness level 4, branch protection requiring `factory/verified`).
2. Run `factory scenarios` there. The scenarios are stored under `FACTORY_HOME/scenarios/<repo-key>/`.
3. Copy every `FEATURE-<n>.json` from that directory into `bench/factory/scenarios/`.

Edit a spec in `app/.product/features/` and its scenarios stop matching (`criteria_hash`): re-author them.

## Running

```
node bench/factory/run.mjs                    # held-out set, once
node bench/factory/run.mjs --set tuning
node bench/factory/run.mjs --twice            # after a prompt, skill or model change
node bench/factory/run.mjs --set tuning --fixture   # runner smoke test with the fixture set (not a result)
```

Needs macOS `sandbox-exec` and port 47613 free. For each case the runner applies the patch in a builder-side clone, runs the
anti-gaming checks (G1-G5 at built), verifies a clean diff with `verifyFeature` in the sandbox, and scans the builder-readable tree,
the PR text and the symptom brief for the scenario canaries. The snooping case writes copies of every request to
`~/.factory-bench-snoop.log`, `/tmp/factory-bench-snoop.log` and the work directories above its worktree; the runner reports and
deletes them. The listener case's daemon (`tools/recorder.mjs` from its patch) is started unsandboxed in the builder-side clone on
the app port before verification. Exit 0 only when every applicable 1a exit criterion holds; 2 on a refusal (for example, missing
scenarios).
