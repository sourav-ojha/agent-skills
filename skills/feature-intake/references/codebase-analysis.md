# Codebase analysis (read-only)

The goal is a spec the implementer can build without guessing where things go. You read; you never edit, run migrations,
install packages or start services that change state. Read-only commands (listing, searching, reading files, `git log`) are fine.

## What to look for

1. **Entry points** the change touches: the route, command, page, job or public function. Search for the nouns in the request.
2. **The nearest existing example** of the same kind of change (another endpoint, another export, another setting). Its file
   layout, naming, error handling and tests are the pattern the spec should name.
3. **Integration points**: data models and migrations, auth and permission checks, configuration, queues, external APIs.
4. **Tests**: where tests for this area live, the runner and the exact command (it becomes "Testing and verification").
5. **Constraints in the docs**: README, CONTRIBUTING, architecture notes, ADRs, lint config. A documented rule beats a default.
6. **What already exists**: if part of the request is already built, say so; the spec covers only the gap.

Stop when you can name the files and the pattern. Reading the whole repository is not the goal.

## What to write in "Existing implementation analysis"

- Paths with a one-line role each (`src/routes/reports.js`: report routes, registered in `src/server.js`).
- The pattern to follow and where it is shown.
- Integration points and their current behaviour, as observed facts.
- Anything you inferred rather than read, labelled as an inference, and anything you could not find, labelled as unknown.

Do not paste code blocks from the repository: name the file and the symbol. Copied code goes stale and invites the implementer
to patch the spec instead of the code.

## Feeding the other sections

| Finding | Goes to |
|---|---|
| An auth check, personal data, money, a migration, a public API | `risk` (see [risk-marking.md](risk-marking.md)) and "Security and performance" |
| A dependency on unbuilt work tracked as another spec | `depends_on` (via `fi new --depends-on`) |
| A convention the change must follow | a `TR-n` requirement with its own criterion, or "Technical considerations" |
| A conflict between the request and the code | "Assumptions and unresolved decisions", `[BLOCKING]` if it changes what was asked |
| The test command | "Testing and verification", backticked |
