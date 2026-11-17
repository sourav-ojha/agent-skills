# Guide: review and quality

Six skills for reviewing code, responding to review, fixing bugs and proving work is done.

| Skill | Use it for |
|---|---|
| `pr-review` | **Quick** single-pass PR review inline, no sub-agents. Command: `/pr-review [PR | URL]` |
| `pr-review-orchestrator` | **Deep** multi-agent PR review: establishes the PR's intent, dispatches parallel specialists, runs the project's own build/tests, verifies and de-duplicates findings, gives a verdict. Command: `/deep-pr-review [PR | URL]` |
| `requesting-code-review` | You (or an agent) asking for a review of your own work: after each task, after a major feature, before merge |
| `receiving-code-review` | Acting on feedback with rigor: verify before implementing, push back when the feedback is wrong, no performative agreement |
| `systematic-debugging` | Any bug, failing test or unexpected behaviour: find the root cause before proposing a fix |
| `verification-before-completion` | Before claiming anything is done, fixed or passing: run the command, read the output, then say so |

## Which review?

| You say | Skill |
|---|---|
| "review PR 42", "is this ready to merge" (the default) | `pr-review-orchestrator` |
| "quick look", "light review", `/pr-review` | `pr-review` |
| "review my changes before I open a PR" | `requesting-code-review` |
| "here are the review comments, address them" | `receiving-code-review` |

With no PR number, both commands review the current branch's PR, or the branch diff against its base.

## Typical loops

**Reviewing**: `/deep-pr-review 42` → read the findings table and verdict → fix what matters.

**Being reviewed**: reviewer comments → `receiving-code-review` (clarify unclear items first, verify each against the code, implement in order, push back with reasons where wrong) → `verification-before-completion` → reply.

**Bug**: `systematic-debugging` (investigate, find the pattern, test one hypothesis at a time, then fix) → write the failing test first (`test-driven-development`) → `verification-before-completion`.

## Combine with
- **[implementer](implementer.md)** and the **[build workflow](build-workflow.md)** call these during delivery; run `/deep-pr-review` on the PR they produce.
- **[autonomy-and-memory](autonomy-and-memory.md)**: `retro` after a hard debugging session turns the lessons into durable notes.

## Limits
Deep review costs several agents' tokens; for trivial diffs it limits itself to a cheap single pass. Reviews check what the diff shows; they do not replace running the software.
