# Self-Review Subagents

Two distinct reviews. Different agents, different questions, different timing.

---

## A. Per-phase code review (fresh context)

**When:** immediately after each phase reaches its verifiable state, before starting
the next phase.

**Why fresh context:** you cannot review your own reasoning chain. An agent that
never saw you decide has no sunk cost in the decision. Do **not** paste your plan,
your rationale, or your justifications — they contaminate the review.

**Dispatch:** `Agent` tool, `subagent_type: "general-purpose"` (or the project's own
code-reviewer agent if one exists). Run in background; collect before next phase.

### Prompt template

```
You are reviewing code you have never seen, written by someone else. You have no
context on why any choice was made — that is intentional. Do not assume the author
was right.

Repo: <path>
Rules the code must obey: read <CLAUDE.md / AI_RULES.md / AGENTS.md — list actual paths>

The change under review:
  git diff <base>..HEAD     (or: files X, Y, Z)

This change was supposed to accomplish: <one sentence, the phase goal — nothing more>

Find, in priority order:
1. Correctness bugs — wrong logic, off-by-one, unhandled null/error, race, wrong
   state transition. Give a concrete failing input for each.
2. Regressions — existing behaviour this breaks. Check callers of every changed
   signature.
3. Rule violations — anything contradicting the rules files above. Quote the rule.
4. Security — injection, authz/tenant-isolation gaps, secret exposure, unsafe
   deserialization, missing validation at a trust boundary.
5. Missing edge cases — empty, huge, concurrent, malformed, unauthorized.

Do NOT report: style, naming, formatting, "consider extracting", speculative
future-proofing, or anything a linter would catch.

For each finding: file:line, one-sentence defect, concrete failure scenario, and
BLOCKING or NON-BLOCKING. Blocking = bug, security hole, or rule violation.
If you find nothing real, say so — do not invent findings to seem useful.
```

### Handling results

- **BLOCKING** → fix now, before the next phase. Re-verify.
- **NON-BLOCKING** → log verbatim into the summary's review section.
- **Disagree with a finding?** Verify against the code yourself. If the reviewer is
  wrong, note it in the summary with the reason. Never dismiss silently.

---

## B. End-of-session audience review

**When:** once, after the last phase, before writing the summary.

**Why:** the per-phase reviews prove the code is correct. This proves the code is
*the right thing*. Correct code that misses the requirement is still a failure.

### Determine the audience first

Read the project's product docs — product context, PRD, README, target-user notes,
compliance targets. Identify concretely: **who uses this, who buys it, what regime
governs it.** If docs are silent, infer from the domain and state the inference as
an assumption.

### Prompt template

```
You are a domain reviewer for this product. You did not write any of this code and
were not part of planning it.

Product: <what it is, one paragraph from the product docs>
Audience: <who uses it / buys it / is governed by it — be concrete>
Governing constraints: <compliance regime, security invariants, contractual promises>
Relevant docs: <paths>

The task requested was: <the user's original ask, verbatim>
The plan executed was: <phase list, one line each>
The result: git diff <base>..HEAD

Answer these, with evidence from the diff and docs:

1. Does this satisfy what the audience actually needs, or only the literal wording
   of the ask? Name any gap between the two.
2. Which parts of the plan drifted from documented product/architecture decisions?
   Quote the decision.
3. What would this audience immediately notice as missing, wrong, or unusable?
   Think like the person who has to live with it, not the person who built it.
4. Any workflow/state/lifecycle step that exists in the domain but not in this
   implementation?
5. Is anything here over-built relative to the ask — scope the user did not request?

Be specific and evidence-backed. "Looks good" with no evidence is not a review.
```

### Handling results

Same triage: blocking gaps (requirement genuinely missed) get fixed; the rest goes
into **Needs your call** in the summary, ranked by consequence.

---

## Cost control

- Per-phase review: one agent per phase. Not per file.
- Audience review: exactly one, at the end.
- Trivial phases (pure rename, config bump, doc typo) may skip the per-phase review
  — say so in the summary.
- Run reviews in the background so the next phase's prep isn't blocked, but never
  start the next phase's *edits* before the current phase's blocking findings land.
