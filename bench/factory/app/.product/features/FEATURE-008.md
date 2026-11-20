---
type: feature-spec
id: FEATURE-008
opportunity: OPP-001
status: ready
---
# Task counts

## 1. Feature overview

People see how many tasks they have, open and done.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** open and completed tasks **When** the counts are fetched **Then** `total`, `open` and `done` match the tasks |

## 11. Edge cases

- EC-1: with no tasks every count is 0

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `GET /api/stats` → 200 `{"total": number, "open": number, "done": number}`

## 14. Out of scope

- Persistence across restarts
- Authentication
