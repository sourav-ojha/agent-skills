# Evidence and severity

## Kinds
| Kind | Needs | May be |
|---|---|---|
| `measured` | `evidence.tool` (name and version), `evidence.value`; viewport and state when relevant | any severity |
| `rule` | `evidence.cite` (a standard or documentation URL) and `evidence.value` (what the page shows) | any severity |
| `judgment` | `evidence.crop` (a file in `.experience/evidence/`), `evidence.numbers` (the measurements behind it), `passes: {seen, of}` with at least 2 of 3 | Medium, Low or Info |
| `needs-data` | `evidence.what_to_pull` (what the user should fetch and from where) | Info |
| `needs-human-check` | tool and elements | Info (for example axe "incomplete" results) |

Anything about rankings, traffic, conversion or user behaviour that you did not measure is `needs-data`, never a finding.

## Severity
| Level | Meaning | Examples |
|---|---|---|
| Critical | blocks use, indexing or access | production `noindex`, unusable layout |
| High | degrades many pages or a core flow | most links only exist after JavaScript, page scrolls sideways on mobile, serious a11y violation |
| Medium | visible quality or discoverability loss | missing description, ungrouped footer, large empty column |
| Low | polish | stray gap, generic anchor text |
| Info | needs data or a person | staging noindex, needs-human-check |

Effort: **S** (one component or tag), **M** (several components or a template), **L** (architecture or rendering change). Rank is severity weight divided by effort; Info is never ranked.

## Finding fields
`rule`, `route`, `selector`, `category` (layout, navigation, seo, a11y, performance, copy, data), `kind`, `severity`, `effort`, `title`, `group` (root cause: the shared component, token or template one fix would change), `evidence`, `proposed_fix`, `acceptance` (Given/When/Then list), optional `retest` (the rule id to re-run). The helper owns `id` (stable from rule, route and selector), `status`, decisions and history; a finding file can never set them.

## Writing a good finding
Title names the problem and where, not the fix. Evidence is something a person can verify in a minute. The acceptance criterion is checkable by the same probe that found it. Group by cause so one fix clears many findings. Repeats across pages are one finding with the viewports and routes listed.
