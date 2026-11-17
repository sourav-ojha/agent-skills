---
name: phased-review
description: "Orchestrate phase-by-phase implementation with code review loops. Usage: /phased-review <plan-path>"
---

# Phased Implementation Review Workflow

Manages a phase-by-phase implementation + review cycle for structured plans.

## Command

```
/phased-review <plan-path>
```

## Arguments

- `plan-path` (required): Relative path to the plan file from project root

## Workflow

### 1. Initialize

1. Resolve the plan file path from project root
2. Parse the plan file to extract phases (supports markdown headers with checklists or numbered lists)
3. Check if `reviews/progress.md` exists:
   - If yes → read completed phases and find next incomplete
   - If no → create `reviews/progress.md` with phase list
4. If all phases complete → announce success and exit
5. Announce current phase with its scope

### 2. Implementation Phase

User implements the current phase. The skill:
- Is available for questions
- Can run code review on demand: invoke `pr-review-toolkit:review-pr`
- Waits for user to signal completion

### 3. Review Phase

When user says "review phase N" or similar:

1. **Code Review**: Invoke `pr-review-toolkit:review-pr` on changed files since last commit
2. **Scope Verification**: Check plan items for current phase against actual changes
3. **Feedback**: Write findings to `reviews/phase-N/feedback.md`

### 4. Decision

- **Issues found**: Present feedback, wait for user to address
- **Approved**: Proceed to commit

### 5. Commit & Progress

1. Create commit: `git add -A && git commit -m "[Phase N] <Phase title>"`
2. Update `reviews/progress.md`: mark phase complete
3. Create `reviews/phase-N/feedback.md` with approved status
4. Loop to next phase or announce completion

### Resume Behavior

When skill runs again:
- Reads `reviews/progress.md`
- Identifies first incomplete phase
- Resumes from there (no reprocessing completed phases)

## Plan File Format

The skill parses markdown plans. Supported formats:

**Format A: Checkbox list**
```markdown
## Phase 1: Name
- [x] Completed item
- [ ] Pending item

## Phase 2: Name
```

**Format B: Numbered list**
```markdown
## Phase 1: Name

1. First item
2. Second item
```

## Error Handling

- **Plan file not found**: Error with path suggestion
- **No reviews directory**: Create it automatically
- **Git not clean**: Warn before commit, offer to stash or abort
- **User abandons**: Progress saved, can resume later

## Session Behavior

- Each phase requires explicit user trigger for review
- Skill does not auto-trigger reviews without user input
- After each phase, re-invoke `/phased-review` to continue to the next phase