---
type: feature-spec
id: FEATURE-006
opportunity: OPP-001
status: ready
---
# Due dates

## 1. Feature overview

People give a task a due date (a calendar date, no time).

Tasks live in memory: every app start begins with an empty list. Task ids are strings assigned in creation order ("1", "2", ...).

## 10. Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Given** a new task with `due` `2027-03-15` **When** it is created **Then** the response carries `due` `2027-03-15` |
| AC-2 | **Given** a task created with a due date **When** it is fetched **Then** it carries that due date unchanged |

## 11. Edge cases

- EC-1: a task created without a due date has `due` null
- EC-2: a real leap day such as `2028-02-29` is accepted

## 12. Error and failure scenarios

- ER-1: a due date that is not `YYYY-MM-DD`, or not a real calendar date (such as `2027-02-30`) → 400 with `{"error": "invalid_due"}`

## HTTP contract

- `POST /api/tasks` body `{"title": string, "done"?: boolean, "due"?: "YYYY-MM-DD"}` → 201 with the task including `due` (string or null); 400 `{"error": "invalid_due"}`
- `GET /api/tasks/{id}` → 200 with the task; 404 `{"error": "not_found"}` for an unknown id

## 14. Out of scope

- Persistence across restarts
- Authentication
