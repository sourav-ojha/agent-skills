---
type: feature-spec
id: FEATURE-014
opportunity: OPP-001
status: ready
---
# Tag tasks

## 1. Feature overview

People label tasks with short tags.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a task **When** a tag is added **Then** the response is 200 with the task and its `tags` include the tag |
| AC-2 | **Given** a tagged task **When** it is fetched **Then** its `tags` include the tag |
| AC-3 | **Given** a task tagged `home` **When** the tag `work` is added **Then** its `tags` are `home` then `work` |

## 11. Edge cases

- EC-1: adding a tag the task already has keeps a single copy
- EC-2: a new task has an empty `tags` list

## 12. Error and failure scenarios

- ER-1: a tag that is not 1-30 characters of lower-case letters, digits or hyphens → 400 with `{"error": "invalid_tag"}`
- ER-2: tagging an unknown task id → 404 with `{"error": "not_found"}`

## HTTP contract

- `POST /api/tasks` body `{"title": string, "done"?: boolean}` → 201 with the task including `tags` (an empty list)
- `POST /api/tasks/{id}/tags` body `{"tag": string}` → 200 with the updated task; 400 `{"error": "invalid_tag"}`; 404 `{"error": "not_found"}`
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
