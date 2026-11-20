---
type: feature-spec
id: FEATURE-007
opportunity: OPP-001
status: ready
---
# Search tasks

## 1. Feature overview

People find tasks by a piece of their title.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** several tasks **When** the list is searched with `q` **Then** only tasks whose title contains `q` anywhere are returned |

## 11. Edge cases

- EC-1: the match ignores letter case (`MILK` finds "Buy milk")
- EC-2: an empty `q` returns every task

## 12. Error and failure scenarios

- ER-1: a `q` longer than 100 characters → 400 with `{"error": "invalid_query"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `GET /api/tasks?q=<text>` → 200 `{"items": [task, ...]}` whose title contains the text, ignoring case; 400 `{"error": "invalid_query"}`

## 14. Out of scope

- Persistence across restarts
- Authentication
