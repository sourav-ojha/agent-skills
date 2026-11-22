# Writing the spec: sections, criteria and frontmatter

The template is `templates/feature-specification.md`; `fi new` copies it. The rules below are what `fi validate` and the
factory's criteria extractor enforce. Breaking one is an error, not a style issue.

## Frontmatter

One `key: value` per line, top level only. No inline `#` comments (readers keep everything after the colon), no nested YAML,
no duplicate keys, lists as comma-separated text. Required: `type: feature-spec`, `id`, `title`, `status`, `origin: intake`,
`risk`, `depends_on` (may be empty), `delivery` (`none|partial|complete`), `source_sha` (`none` or `sha256:<64 hex>`).
Written by the helper only: `parent`, `superseded_by`, `source_ref`. An intake spec never names an `opportunity`.

## Sections, in this order

Context and problem statement · Objective and expected behavior · Existing implementation analysis · Scope and non-goals ·
Functional and technical requirements · Acceptance criteria · Edge cases · Error and failure scenarios · (optional) HTTP contract ·
Technical considerations · Security and performance · Testing and verification · Assumptions and unresolved decisions ·
(split children) Traces · Approval history · (after delivery) Delivery log.

Headings are `## ` lines; a leading `N. ` is allowed. Do not rename the four factory headings (`Acceptance criteria`, `Edge cases`,
`Error and failure scenarios`, `HTTP contract`): a variant such as `## 6) Acceptance criteria` is not recognised.

## Requirements and criteria

```
| ID | Requirement |
|----|-------------|
| FR-1 | Exports the visible report rows as CSV. |
| TR-1 | The export streams; memory does not grow with row count. |

| ID | Requirement | Criterion |
|----|-------------|-----------|
| AC-1 | FR-1 | **Given** a report with 3 rows **When** the user clicks Export **Then** a CSV with a header and 3 rows downloads |
| AC-2 | TR-1 | **Given** 100000 rows **When** exported **Then** peak memory stays under 50 MB |
```

- The first cell of an AC row is `AC-<n>` (canonical: `AC-1`, not `AC1` or `ac-1`), unique. Every `FR-n`/`TR-n` must appear in
  some AC row (R3). Criteria are observable: what a test or a person can see, not how the code is built.
- One behaviour per criterion. Numbers where they matter (limits, codes, sizes). No "fast", "user-friendly", "robust".
- Edge cases and error scenarios are bullets: `- EC-1: empty report -> CSV with the header only`,
  `- ER-1: export fails mid-stream -> the user sees an error and no partial file is saved`.
- AC, EC and ER ids appear only in their own sections (an ID-shaped line elsewhere is an error); no numbered, `+` or backticked items.
- HTTP contract (only when the feature has an HTTP API): one bullet per endpoint holding a backticked `METHOD /path`, for
  example a bullet whose text is `GET /api/reports/:id/export` in backticks. Delete the section otherwise.

## Other sections

- **Scope and non-goals** needs a line starting `Non-goals:` with real content (R5).
- **Testing and verification** names at least one backticked command (R6 checks only that) and, by convention, the AC ids it proves, e.g. ``Run `npm test -- export` (AC-1, AC-2)``.
- **Security and performance**: for `risk: high` a line starting `Lens:` (R7); see [risk-marking.md](risk-marking.md).
- **Assumptions and unresolved decisions**: one line per assumption; `[BLOCKING]` only for an open decision (R4).

## Traces (split children)

Written by `fi split`: one row per parent criterion, first cell the full parent id plus criterion, second cell this child's
AC ids (comma separated):

```
| Parent criterion | Child criterion |
|------------------|-----------------|
| FEATURE-001 AC-1 | AC-1, AC-2 |
| FEATURE-001 AC-2 | AC-3 |
```

Every parent criterion must have a row, every row must name the parent, and every child id must be an AC of this spec. An
empty second cell is a warning on a draft and fails `fi check` (R9); on a ready spec it is a validate error.

## Approval history and Delivery log

Leave the Approval history table to the helper. `## Delivery log`, when present, is written by the implementer's close-out and
must be the **last block** of the file; anything after it is an error.
