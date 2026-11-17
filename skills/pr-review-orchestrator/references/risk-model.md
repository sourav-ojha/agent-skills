# Risk Model — Tier Selection

Depth is the main cost lever. Pick the tier from what the diff **actually touches**, not from how important the PR feels.

## Signals

Read the changed-file list and the diff stat first (`gh pr diff <N> --name-only`, `gh pr view <N> --json additions,deletions,changedFiles`).

### First: compute the *reviewable* surface, not the raw line count

Raw `additions` is a bad risk signal — one regenerated snapshot, lockfile, or fixture dominates it. Before scoring anything, subtract:

- generated artifacts (lockfiles, ORM snapshots, `*.pb.go`, `*.generated.*`, `dist/`, minified bundles, compiled schemas)
- binary files (`gh pr diff` shows them as `Binary files differ` — never try to read one)
- vendored directories
- large data fixtures and seed dumps

Score breadth on what is left. A PR of +7600 lines where 7590 are a regenerated snapshot is a **10-line PR** with a generated-artifact check, not a T4.

For generated files, the review question is not their content but: **was this regenerated from its source rather than hand-edited, and does it match the source in this diff?** One line in the report, not a specialist.

### Escalating signals

| Signal | How to detect | Raises to |
|---|---|---|
| Authentication / authorization / session / token code | paths or symbols containing `auth`, `session`, `token`, `permission`, `role`, `rbac`, `policy`, `guard`, `middleware` | T3+ |
| Tenant / ownership scoping | `tenant`, `org`, `workspace`, `account_id` in a query or filter | T4 |
| Money | `payment`, `invoice`, `charge`, `payout`, `billing`, `price`, `refund`, currency arithmetic | T4 |
| Database migration or schema | `migrations/`, `schema.*`, `*.sql`, ORM model definitions | T4 |
| Cryptography / secrets | `crypt`, `encrypt`, `hash`, `sign`, `key`, `secret` | T4 |
| Concurrency | locks, transactions, queues, workers, `Promise.all`, mutexes, retries | T4 |
| Infrastructure / deploy | Terraform, Helm, k8s manifests, Dockerfile, CI workflow, IaC | T4 |
| Public API contract | route definitions, response schemas, OpenAPI, protobuf, event payloads | T3+ |
| External input handling | file upload, webhook receiver, URL fetch, parser, deserialization | T3+ |
| New third-party dependency | lockfile + manifest both changed | T3 |
| Core business rule / state machine | status transitions, lifecycle logic, domain invariants | T2+ |
| Breadth | >600 changed lines **or** >15 files **or** >4 modules | +1 tier, only if a real extra dimension is present |

### De-escalating signals

| Signal | Effect |
|---|---|
| Only `*.md`, comments, or license/changelog | **T0** |
| Only lockfile / version bump with no manifest logic change | **T0** |
| Only generated output (verify it matches its source) | **T0** — check regeneration, nothing else |
| Only formatting (diff is whitespace/reordering) | **T0** |
| Only test files, no production change | **T1** — test-quality specialist alone |
| Only styling (CSS/tokens) with no behaviour | **T1** |
| Pure revert of a known commit | **T1**, *only if* no escalating signal — verify cleanliness by comparing the diff against the inverse of the reverted commit (`git show <sha>`); a hand-edited revert is not a revert, review it as an ordinary change |

**De-escalation applies only when no escalating signal is present.** Escalation wins every collision. Concretely:

| Case | Tier | Why |
|---|---|---|
| Test-only PR against the auth module | **T3** | `auth` escalates; test-only does not override it |
| Revert of a security fix | **T3** | Reverting a fix reintroduces the vulnerability — the highest-value security review there is |
| Docs-only PR under `docs/architecture/` describing tenant isolation | **T0** | The file is prose. Path keywords escalate only when they name **code** that runs |

Match escalating signals against **code paths**, not any file whose name contains the word. A markdown file mentioning `payment` is documentation.

## Tiers → specialists

Tiers are cumulative — each includes everything below it.

| Tier | Specialists |
|---|---|
| **T0** | None. Orchestrator reads the diff itself and reports. |
| **T1** | `pr-correctness-tracer` |
| **T2** | + `pr-architecture-reviewer`, `pr-test-quality-reviewer` |
| **T3** | + `pr-security-reviewer` (+ `pr-data-compat-reviewer` if contracts/schema changed) |
| **T4** | + `pr-data-compat-reviewer`, `pr-ops-perf-reviewer` |

**Conditional add-ons at any tier ≥ T1** — each adds a specialist the tier does not *already* include. If the tier already includes it, the add-on is a no-op, not a second dispatch.

| Add | When the diff contains |
|---|---|
| `pr-error-path-reviewer` | new/changed catch blocks, fallbacks, error swallowing, `?.`/`??` around a failure path |
| `pr-ops-perf-reviewer` | a loop containing I/O, a new list endpoint, a new outbound call, a background job |
| `pr-review-toolkit:type-design-analyzer` | non-trivial new types, data models, or discriminated unions — and tier ≥ T2 |

## Hard rules

- **One dimension, one agent.** Never dispatch two reviewers covering the same ground — you pay twice, once to generate duplicates and once to merge them.
- **Never dispatch a specialist whose dimension the diff does not touch.** A security review of a CSS change costs money and returns nothing.
- **Never dispatch a write-capable agent.** `pr-review-toolkit:code-simplifier` and `code-reviewer` modify code by design; `pr-test-analyzer` and `silent-failure-hunter` hold Edit/Write and are superseded by the read-only `pr-test-quality-reviewer` and `pr-error-path-reviewer`. Only `type-design-analyzer` is used from the toolkit.
- Prefer a **project-specific reviewer** over a generic one for any dimension it covers (see `capability-routing.md`).
- Prefer **one specialist doing its job well** to three producing overlapping candidates.
- If a tier decision is genuinely borderline, choose the lower tier and state what you skipped in the depth note. If a finding later suggests you under-reviewed, escalate that one dimension rather than restarting the review.
