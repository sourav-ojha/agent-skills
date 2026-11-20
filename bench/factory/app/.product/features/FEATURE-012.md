---
type: feature-spec
id: FEATURE-012
opportunity: OPP-001
status: ready
---
# Sort tasks

## 1. Feature overview

People sort the task list by title.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** several tasks **When** the list is fetched with `sort=title` **Then** tasks are in ascending title order |
| AC-2 | **Given** several tasks **When** the list is fetched with `sort=-title` **Then** tasks are in descending title order |
| AC-3 | **Given** several tasks **When** the list is fetched without `sort` or with `sort=created` **Then** tasks are in creation order |

## 11. Edge cases

- EC-1: title order ignores letter case ("apple" comes before "Banana")

## 12. Error and failure scenarios

- ER-1: any other `sort` value → 400 with `{"error": "invalid_sort"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `GET /api/tasks?sort=title|-title|created` → 200 `{"items": [task, ...]}` in that order; 400 `{"error": "invalid_sort"}`

## 14. Out of scope

- Persistence across restarts
- Authentication
