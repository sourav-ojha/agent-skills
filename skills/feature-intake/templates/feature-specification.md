---
type: feature-spec
id: {{id}}
title: {{title}}
status: draft
origin: intake
risk: low
depends_on:
delivery: none
source_sha: none
---

# {{title}}

## 1. Context and problem statement

{{Who has the problem, what happens today, and why it matters now.}}

## 2. Objective and expected behavior

{{The observable behavior once this is delivered, in one or two sentences.}}

## 3. Existing implementation analysis

{{Paths, patterns and integration points read in the codebase (read-only evidence).}}

## 4. Scope and non-goals

In scope: {{what this feature changes}}

Non-goals: {{what it deliberately does not change}}

## 5. Functional and technical requirements

| ID | Requirement |
|----|-------------|
| FR-1 | {{one testable requirement; add TR-n rows for technical requirements}} |

## 6. Acceptance criteria

| ID | Requirement | Criterion |
|----|-------------|-----------|
| AC-1 | FR-1 | **Given** {{context}} **When** {{action}} **Then** {{observable outcome}} |

## 7. Edge cases

- EC-1: {{case}} -> {{expected behavior}}

## 8. Error and failure scenarios

- ER-1: {{failure}} -> {{expected behavior}}

## HTTP contract

<!-- Optional: one bullet per endpoint, each a backticked METHOD /path. Delete this section when the feature has no HTTP API. -->

<!-- Optional CLI contract, for a command-line feature. To use it, uncomment the block below, one backticked command per bullet. The first word is the program display name and is ignored when matching; an angle-bracket name stands for one argument and a final three-dot word allows more. Delete it when the feature has no CLI. An empty CLI contract section is an error. -->

<!--
## CLI contract

- `seo about --json`
-->

## 9. Technical considerations

{{API, database, authentication and authorization, dependencies.}}

## 10. Security and performance

{{Security and performance impact. For risk: high, add a line starting "Lens:" recording the security or database review.}}

## 11. Testing and verification

{{The exact command(s), each in backticks, and the AC ids each one proves.}}

## 12. Assumptions and unresolved decisions

{{Assumptions made. Tag each open decision that must be settled before approval as BLOCKING in square brackets.}}

## 13. Approval history

| Date | Action | By | Note | Content hash |
|------|--------|----|------|--------------|
