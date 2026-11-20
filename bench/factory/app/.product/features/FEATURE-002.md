---
type: feature-spec
id: FEATURE-002
opportunity: OPP-001
status: ready
---
# Delete a task

## 1. Feature overview

People remove a task they no longer need.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a task **When** it is deleted **Then** the response is 204 with no body |
| AC-2 | **Given** a deleted task **When** the list or the task is fetched **Then** it is gone (absent from the list; the task itself is 404) |

## 11. Edge cases

- EC-1: deleting one task leaves every other task in the list

## 12. Error and failure scenarios

- ER-1: deleting an unknown task id → 404 with `{"error": "not_found"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `DELETE /api/tasks/{id}` → 204 with no body; 404 `{"error": "not_found"}` for an unknown id
- `GET /api/tasks` → 200 `{"items": [task, ...]}` in creation order
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
