---
type: feature-spec
id: FEATURE-001
opportunity: OPP-001
status: ready
---
# Complete a task

## 1. Feature overview

People mark a task as done.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** an open task **When** it is completed **Then** the response is 200 with the task and `done` is true |
| AC-2 | **Given** a completed task **When** it is fetched **Then** `done` is true |

## 11. Edge cases

- EC-1: completing a task that is already done returns 200 and the task stays done

## 12. Error and failure scenarios

- ER-1: completing an unknown task id → 404 with `{"error": "not_found"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `POST /api/tasks/{id}/complete` → 200 with the updated task; 404 `{"error": "not_found"}` for an unknown id
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
