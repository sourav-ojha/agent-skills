---
description: Full PR review against the project's own conventions — findings, test-quality check, over-engineering check, and verdict
argument-hint: "[PR number | URL | blank for current branch] [--repo owner/name]"
allowed-tools: Bash, Read, Grep, Glob, Skill, ToolSearch, TaskCreate, TaskUpdate
---

Invoke the `pr-review` skill and follow it exactly.

Target: $ARGUMENTS

If no target is given, review the PR for the current branch; if the branch has no PR, review the branch diff against its base and say so in the report.

Report in chat only. Do not post to GitHub unless I explicitly ask.
