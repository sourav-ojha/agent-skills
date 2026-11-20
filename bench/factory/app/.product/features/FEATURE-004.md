---
type: feature-spec
id: FEATURE-004
opportunity: OPP-001
status: ready
---
# Filter tasks by status

## 1. Feature overview

People list only open or only completed tasks.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** open and completed tasks **When** the list is filtered with `status=open` **Then** only open tasks are returned |
| AC-2 | **Given** open and completed tasks **When** the list is filtered with `status=done` **Then** only completed tasks are returned |

## 11. Edge cases

- EC-1: without a `status` parameter every task is returned

## 12. Error and failure scenarios

- ER-1: any other `status` value → 400 with `{"error": "invalid_status"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `GET /api/tasks?status=open|done` → 200 `{"items": [task, ...]}` filtered by status; 400 `{"error": "invalid_status"}` for another value

## 14. Out of scope

- Persistence across restarts
- Authentication
