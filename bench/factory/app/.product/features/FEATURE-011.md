---
type: feature-spec
id: FEATURE-011
opportunity: OPP-001
status: ready
---
# Reopen a task

## 1. Feature overview

People reopen a task they completed by mistake.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a completed task **When** it is reopened **Then** the response is 200 with the task and `done` is false |
| AC-2 | **Given** a reopened task **When** it is fetched **Then** `done` is false |

## 11. Edge cases

- EC-1: reopening a task that is already open returns 200 and it stays open

## 12. Error and failure scenarios

- ER-1: reopening an unknown task id → 404 with `{"error": "not_found"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `POST /api/tasks/{id}/reopen` → 200 with the updated task; 404 `{"error": "not_found"}` for an unknown id
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
