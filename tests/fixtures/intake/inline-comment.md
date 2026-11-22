---
type: feature-spec
id: FEATURE-001
title: Health check endpoint
status: ready   # draft | ready
origin: intake
risk: low
depends_on:
delivery: none
source_sha: none
---

# Health check endpoint

## 1. Context and problem statement

Operators have no cheap way to tell whether the service is up.

## 2. Objective and expected behavior

The service answers a health probe with a small JSON body.

## 3. Existing implementation analysis

The server has a router in `src/server.js` and no health route.

## 4. Scope and non-goals

In scope: one read-only health route.

Non-goals: readiness of downstream dependencies, authentication, metrics.

## 5. Functional and technical requirements

| ID | Requirement |
|----|-------------|
| FR-1 | The service exposes a health route that returns status ok. |

## 6. Acceptance criteria

| ID | Requirement | Criterion |
|----|-------------|-----------|
| AC-1 | FR-1 | **Given** the service is running **When** a client requests the health route **Then** it receives HTTP 200 with a JSON body whose status is ok |

## 7. Edge cases

- EC-1: A request with a query string still returns HTTP 200.

## 8. Error and failure scenarios

- ER-1: A non-GET method on the health route returns HTTP 405.

## HTTP contract

- `GET /api/health`

## 9. Technical considerations

The route is registered before any authentication middleware.

## 10. Security and performance

The route returns no internal state and does no I/O.

## 11. Testing and verification

Run `node --test tests/health.test.mjs` and confirm AC-1 passes.

## 12. Assumptions and unresolved decisions

None.

## 13. Approval history

| Date | Action | By | Note | Content hash |
|------|--------|----|------|--------------|
