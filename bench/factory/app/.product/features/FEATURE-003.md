---
type: feature-spec
id: FEATURE-003
opportunity: OPP-001
status: ready
---
# Rename a task

## 1. Feature overview

People change the title of a task.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a task **When** it is renamed **Then** the response is 200 with the task carrying the new title |
| AC-2 | **Given** a renamed task **When** it is fetched **Then** it has the new title |

## 11. Edge cases

- EC-1: leading and trailing whitespace of the new title is removed

## 12. Error and failure scenarios

- ER-1: a missing, empty or whitespace-only title → 400 with `{"error": "invalid_title"}`
- ER-2: renaming an unknown task id → 404 with `{"error": "not_found"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `PATCH /api/tasks/{id}` body `{"title": string}` → 200 with the updated task; 400 `{"error": "invalid_title"}`; 404 `{"error": "not_found"}`
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
