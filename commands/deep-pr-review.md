---
description: Deep multi-agent PR review — intent model, parallel specialists, verified findings table, merge verdict
argument-hint: "[PR number | URL | blank for current branch] [--repo owner/name]"
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, ToolSearch, TaskCreate, TaskUpdate
---

Invoke the `pr-review-orchestrator` skill and follow it exactly.

Target: $ARGUMENTS

If no target is given, review the PR for the current branch; if the branch has no PR, review the branch diff against its base and say so in the report.

Read-only: do not edit, stage, commit, push, or merge anything. Report in chat only — do not post to GitHub unless I explicitly ask.
