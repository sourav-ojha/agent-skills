---
type: feature-spec
id: FEATURE-005
opportunity: OPP-001
status: ready
---
# Task priority

## 1. Feature overview

People give a task a priority when they create it.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a new task with `priority` `high` **When** it is created **Then** the response carries `priority` `high` |
| AC-2 | **Given** a task created with a priority **When** it is fetched **Then** it carries that priority |

## 11. Edge cases

- EC-1: a task created without a priority has `priority` `normal`

## 12. Error and failure scenarios

- ER-1: a priority other than `low`, `normal` or `high` → 400 with `{"error": "invalid_priority"}`

## HTTP contract

- `POST /api/tasks` body `{"title": string, "done"?: boolean, "priority"?: "low"|"normal"|"high"}` → 201 with the task including `priority`; 400 `{"error": "invalid_priority"}`
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
