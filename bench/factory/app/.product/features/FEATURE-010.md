---
type: feature-spec
id: FEATURE-010
opportunity: OPP-001
status: ready
---
# Title rules

## 1. Feature overview

Task titles are tidied and kept to a readable length when a task is created.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a title with spaces around it **When** the task is created **Then** the stored title has them removed (inner spaces kept) |
| AC-2 | **Given** a task created with a padded title **When** it is fetched **Then** its title is the trimmed title |

## 11. Edge cases

- EC-1: a title of exactly 200 characters (after trimming) is accepted

## 12. Error and failure scenarios

- ER-1: a title longer than 200 characters after trimming → 400 with `{"error": "invalid_title"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title or one over 200 characters
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
