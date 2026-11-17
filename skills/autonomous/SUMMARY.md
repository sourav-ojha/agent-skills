# End-of-Session Summary

Emitted twice, identical content: **in chat** as the final message, and **as the PR
description** (`gh pr create --body-file` / `gh pr edit --body-file`). If no PR was
opened, chat only — and say why there is no PR.

This is the only thing the user reads. It replaces every question you didn't ask.
Lead with what needs their judgement, not with what went well.

---

## Template

```markdown
## Autonomous session — <task, one line>

**Status:** Complete | Complete with caveats | Stopped early (<reason>)
**Branch:** `<branch>` · **Phases:** N · **Verification:** <tests/build/lint result>

---

### 1. What was done
- **Phase 1 — <name>:** <one line> ✅
- **Phase 2 — <name>:** <one line> ✅
- **Phase 3 — <name>:** <one line> ⚠️ <caveat>

### 2. Decisions made on your behalf
| Decision | Chose | Rejected | Basis |
|---|---|---|---|
| <the fork> | <what I did> | <alternative> | <doc path / existing pattern / conservative default> |

### 3. Assumptions
Everything here reached the conservative default — docs and code were silent.

- **<assumption>** — if wrong: <what has to change, how expensive>
- **<assumption>** — if wrong: <...>

### 4. Deferred / out of scope
- **<thing>** — <why not done: out of ask / needs your call / blocked>

### 5. Self-review findings
**Per-phase code review (fresh context):**
- ✅ Fixed: <finding> — <how>
- 📋 Logged: <finding> — <why not fixed>
- ❌ Disputed: <finding> — <why reviewer was wrong>

**Audience review (<audience>):**
- <gap or confirmation, with evidence>

### 6. Needs your call
Ranked — highest consequence first. These are the questions I would have asked.

1. **<question>** — I proceeded with <X>. If you'd rather <Y>, <cost to change>.
2. **<question>** — <...>

### 7. Verification evidence
```
<actual command output — test summary, build result. Paste failures verbatim.>
```
```

---

## Rules

- **Honest.** Failing test → paste the failure. Skipped step → say skipped. Never
  report done for partly done.
- **Section 6 is mandatory** and never empty. If you had literally zero forks,
  write "No open questions — every ambiguity resolved from `<doc>`." That itself
  is the signal.
- **Section 3 lists consequences, not just assumptions.** "Assumed X" is useless.
  "Assumed X; if wrong, the service layer needs rewriting" is actionable.
- **No self-congratulation.** No "successfully implemented a robust solution."
  State what exists and what doesn't.
- **Table in section 2 stays a table.** The user scans it; prose hides forks.
- Keep it scannable. A user returning after a day should get the shape in 30
  seconds and the detail on demand.
