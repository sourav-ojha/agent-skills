# Factory benchmark (Phase 1a, API)

The fixture product and runner for the Phase 1a exit criteria in
[docs/factory/specs/phase-1-verification-gate.md](../../docs/factory/specs/phase-1-verification-gate.md) (P1.5).

| Path | What it is |
|---|---|
| `app/` | The base product: a small task-list JSON API (`src/`), its unit tests, `.product/delivery.json` and 14 feature specs (`.product/features/FEATURE-001..014.md`) with AC/EC/ER IDs and an HTTP contract. No feature is implemented yet. |
| `cases/` | One patch per case against `app/`, listed in `cases/cases.json` with its set (`tuning` / `heldout`) and category. FEATURE-001..004 belong to the tuning set and FEATURE-005..014 to the held-out set; the two sets share no feature. |
| `scenarios/` | **The real scenarios**, one `FEATURE-<n>.json` per feature, authored by you (below). **Local only:** everything here except its README is gitignored, because held-out scenarios must never be committed to the repository whose prompts are tuned. Keep them here or anywhere else (`--scenarios-dir`). |
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
3. Copy every `FEATURE-<n>.json` from that directory into `bench/factory/scenarios/` (gitignored; never commit or force-add them), or
   point the runner at another directory with `--scenarios-dir`.

Edit a spec in `app/.product/features/` and its scenarios stop matching (`criteria_hash`): re-author them.

## Running

```
node bench/factory/run.mjs                    # held-out set, once
node bench/factory/run.mjs --set tuning
node bench/factory/run.mjs --twice            # after a prompt, skill or model change
node bench/factory/run.mjs --set tuning --fixture   # runner smoke test with the fixture set (not a result)
```

Exit codes: 0 = an exit-criteria result (full held-out set, authored scenarios, every case as expected, criteria 1-5 ok, and both
runs agree with `--twice`); 3 = every case as expected but not a result (`--only`, the tuning set, or `--fixture`); 1 = a failure;
2 = a refusal. Criterion 1 needs at least 9 stub/wrong/edge cases, so it is n/a on the tuning set. Criterion 6 (a `gh` merge from
the builder's shell refused by branch protection) is not covered here; it is the separate Task 14 step on a scratch GitHub repo.

Needs macOS `sandbox-exec` and port 47613 free. For each case the runner applies the patch in a builder-side clone, runs the
anti-gaming checks (G1-G5 at built), verifies a clean diff with `verifyFeature` in the sandbox, and scans the builder-readable tree,
the PR text and the symptom brief for the scenario canaries. The snooping case writes copies of every request to
`~/.factory-bench-snoop.log`, `/tmp/factory-bench-snoop.log`, the work directories above its worktree and every builder-side clone
of the run; it must verify (pass) with all of those writes denied. The runner reports and deletes any it finds. The listener case's daemon (`tools/recorder.mjs` from its patch) is started unsandboxed in the builder-side clone on
the app port before verification; the expected outcome is verifyFeature's port-in-use refusal (or a pass with nothing leaked). Exit 0 only when every applicable 1a exit criterion holds; 2 on a refusal (for example, missing
scenarios).
