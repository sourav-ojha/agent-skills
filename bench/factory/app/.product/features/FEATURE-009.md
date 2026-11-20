---
type: feature-spec
id: FEATURE-009
opportunity: OPP-001
status: ready
---
# Paged task list

## 1. Feature overview

People page through a long task list.

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** three tasks **When** the list is fetched with `limit=2` **Then** the first two tasks are returned in creation order |
| AC-2 | **Given** three tasks **When** the list is fetched with `limit=2&offset=2` **Then** only the third task is returned |
| AC-3 | **Given** three tasks **When** any page is fetched **Then** `total` is 3 |

## 11. Edge cases

- EC-1: an `offset` past the end returns no items and the real `total`

## 12. Error and failure scenarios

- ER-1: a `limit` that is not an integer from 1 to 100, or an `offset` that is not a non-negative integer → 400 with `{"error": "invalid_paging"}`

## HTTP contract

- `POST /api/tasks` creates a task: body `{"title": string, "done"?: boolean}` → 201 with the task `{"id": string, "title": string, "done": boolean}`; 400 `{"error": "invalid_title"}` for a missing or blank title
- `GET /api/tasks?limit=<1-100>&offset=<n>` → 200 `{"items": [task, ...], "total": number}` (defaults: limit 100, offset 0); 400 `{"error": "invalid_paging"}`

## 14. Out of scope

- Persistence across restarts
- Authentication
