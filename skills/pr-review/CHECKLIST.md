# PR Review Checklist

Per-pass items. Apply what's relevant to the diff — don't mechanically walk every line on a 3-line PR.

---

## Correctness

- Off-by-one in loops, slices, ranges, pagination offsets
- Null / undefined / empty-collection paths
- Async: unawaited promises, floating promises, unhandled rejections, `Promise.all` where one failure should not kill the batch (or vice versa)
- Race conditions: read-modify-write without a lock/transaction, TOCTOU, concurrent state transitions
- Error handling: caught-and-swallowed errors, empty catch blocks, errors logged but execution continues into a bad state, wrong error type propagated to the caller
- Early returns that skip cleanup (transaction rollback, file handles, connection release)
- Boolean logic inversions, negation applied to a nullable, loose vs. strict equality
- State machines: is every new state reachable, and every reachable state handled? Any transition that skips a guard?
- Timezone / date arithmetic, DST, month-end
- Floating point used for money
- Copy-paste bugs: duplicated block with one variable not renamed

## Security

- **Authorization** — is the new route/handler/mutation covered by the project's auth + role checks? Is the check on the *server*, not just the UI?
- **Tenant / ownership scoping** — can a caller reach another tenant's or user's row? Is the scope taken from a trusted source (session/token) rather than a client-supplied field?
- **Injection** — SQL/NoSQL string interpolation, shell, template, path traversal, dynamic-eval family
- **Input validation** — is untrusted input validated at the boundary with the project's schema tool, including new optional fields?
- **Secrets** — keys, tokens, credentials in code, tests, fixtures, logs, or error messages
- **Output** — stack traces / internal identifiers / other users' data in responses; PII in logs
- **XSS** — unescaped rendering, raw-HTML injection props, unsanitized markdown/HTML/SVG
- **SSRF** — server-side fetch of a user-supplied URL without an allowlist
- **File handling** — content-type trust, unbounded upload size, unsanitized filenames, executable/SVG uploads
- **Crypto** — homemade crypto, weak/legacy algorithms, fixed IVs, missing key versioning, non-constant-time comparison of secrets
- **Auth mechanics** — token TTL, revocation on logout/password-change/deactivation, session fixation
- **Rate limiting** on new expensive or auth-adjacent endpoints
- **Dependencies** — new package: is it needed, maintained, and the right size for the job?

## Conventions (project-specific — derive in Phase 1)

- Layering respected (e.g. no business logic in route handlers if the project separates layers)
- File placement and naming match the project's convention for that file type
- Error handling matches the project's idiom (custom error classes vs. thrown strings vs. result types)
- Logging matches the project's logger and field conventions
- API schema / validation defined the way the project defines it (single source of truth, not duplicated)
- Imports: does the project ban direct vendor SDK imports in favour of an adapter layer?
- Config/env access via the project's config module, not raw environment reads scattered around
- Commit messages / PR title match the enforced format
- Generated artifacts (migrations, lockfiles, types) regenerated, not hand-edited

## Over-engineering

Flag when the change does more than the problem requires:

- Abstraction, interface, or base class with exactly one implementation and no concrete second use case
- Config flag / env var / option nobody requested
- Generic type parameters where a concrete type suffices
- "Future-proofing" hooks, plugin registries, strategy patterns for a stable single behaviour
- Defensive checks for states the type system or callers make impossible
- Backwards-compatibility shim in a codebase where you can simply change all call sites
- Caching added without a measured problem
- New dependency for something the stdlib or an existing dep already does
- Retry/circuit-breaker/queue introduced for an operation that can't fail slowly
- Wrapper that only forwards arguments
- Premature extraction: one 12-line function split into four files
- Wider scope than the ticket: unrelated refactors mixed into a bugfix (ask to split)

Also flag the inverse — **under-engineering** — when the change copy-pastes a block that already exists a third time, or hardcodes something the project already has a constant for.

## Test quality

Presence:
- Does every behaviour change have a test? Every bugfix a regression test that fails without the fix?
- New error paths, guards, and permission checks tested, not just the happy path?

Meaningfulness:
- Assertions on real outputs vs. "is defined" / "does not throw" / bare snapshot
- Mocks: is the test asserting on the mock's own configured return value (tautology)? Are the mocks so broad the real code never runs?
- Would the test still pass if the implementation body were deleted or returned a constant? If yes → flag.
- Do test names describe behaviour, or just the method name?
- Is one giant test asserting 20 unrelated things (unclear failure signal)?

Robustness:
- Deterministic: no reliance on real clock, network, random, or wall-time sleeps
- No order-dependence or shared mutable state between tests
- Fixtures/IDs unique per run when the DB is shared
- Cleanup runs even on failure

Boundaries:
- Right level (unit vs. integration vs. e2e) for what's being verified
- Not testing the framework or the ORM
- Edge cases: empty, single, max, boundary values, unicode, concurrent callers

## Data & migrations

- Destructive changes (drop column/table, type narrowing) — is data preserved or intentionally discarded?
- Locking: does the DDL block writes on a large table? Is there a non-blocking alternative?
- New column: nullable, or defaulted with a backfill plan?
- Index present for new query patterns; no redundant/duplicate index
- Foreign keys and cascade behaviour intentional
- Rollback path exists and is correct
- Row-level security / access policy added for a new table if the project uses one
- Migration is idempotent / safe to re-run
- Enum or constrained-value changes coordinated between DB and application code
- Deploy ordering: does the migration need to land before or after the code?

## Performance

- N+1 query in a loop
- Query without a limit on a growing table; missing pagination on a new list endpoint
- Wildcard selects / over-fetching large columns
- Sync CPU-heavy or IO-heavy work on a request path that should be queued
- Unbounded memory: loading a whole table/file into memory
- Missing index for a new filter/sort
- Re-renders / unmemoized expensive computation in hot UI paths
- Sequential awaits that could be parallel (and parallel calls that should be sequential for rate limits)

## API & contracts

- Backwards compatibility: removed or renamed field, narrowed type, changed status code, changed default
- Request validation covers new fields; unknown fields handled per project policy
- Error responses shaped consistently with the rest of the API
- Status codes semantically right (400 vs 403 vs 404 vs 409 vs 422)
- Client-side types regenerated / updated in lockstep with server schema
- Pagination, sorting, filtering params consistent with sibling endpoints
- Idempotency for retryable mutating operations
- Docs/OpenAPI updated if the project generates or maintains them

## Observability & documentation

- Failure paths log enough to debug (with correlation/request id if the project has one)
- No logging of secrets or PII
- New metric/alert if the change introduces a new failure mode worth watching
- Comments explain *why*, not *what*; no stale comment left describing old behaviour
- README / architecture doc / ADR updated when the change alters documented behaviour
- Feature flag has a documented removal condition

## Language-specific quick hits

**TypeScript** — `any` escapes, unchecked casts, non-null assertions on genuinely nullable values, missing `await`, `enum` vs. union per project convention, type-only imports, index signatures hiding missing keys.

**React** — missing/incorrect `useEffect` dependencies, effect that should be an event handler, key from array index, state derived in an effect instead of computed at render, uncleaned subscriptions/timers, uncontrolled→controlled input switch, raw-HTML injection props.

**Python** — mutable default arguments, bare `except:`, broad `except Exception` swallowing, missing context manager for resources, `__eq__` without `__hash__`, blocking call inside async.

**Go** — ignored `err`, `defer` in a loop, goroutine leak, unbuffered channel deadlock, loop-variable capture, missing `context` propagation.

**SQL** — implicit cross join, `NOT IN` with nullable column, missing `ORDER BY` with `LIMIT`, function on an indexed column in `WHERE`.

**Shell** — unquoted variables, missing `set -euo pipefail`, recursive force-delete with an interpolated path.
