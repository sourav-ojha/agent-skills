---
type: feature-spec
id: FEATURE-013
opportunity: OPP-001
status: ready
---
# Clear completed tasks

## 1. Feature overview

People remove every completed task at once.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** open and completed tasks **When** completed tasks are cleared **Then** only the open tasks remain in the list |
| AC-2 | **Given** two completed tasks **When** completed tasks are cleared **Then** the response is 200 with `deleted` 2 |

## 11. Edge cases

- EC-1: with no completed tasks, clearing returns `deleted` 0 and every task remains

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `POST /api/tasks/clear-completed` → 200 `{"deleted": number}`
- `GET /api/tasks` → 200 `{"items": [task, ...]}` in creation order

## 14. Out of scope

- Persistence across restarts
- Authentication
