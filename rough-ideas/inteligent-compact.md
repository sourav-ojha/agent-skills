## Feature: Intelligent Context & Session Management

Enhance the Software Factory skill with an automated context-management strategy for long-running orchestrator and subagent sessions.

### Objective

Minimize unnecessary token consumption, preserve critical project knowledge across compaction, and maintain continuity throughout long-running development workflows.

### Requirements

1. **Context Monitoring**
   - Monitor the active agent's context utilization.
   - Introduce configurable context thresholds (default proactive threshold: 70–75%).
   - Do not compact unnecessarily when context is low or the current task is actively progressing.
   - Retain Claude Code's native automatic compaction as a fallback.

2. **Intelligent Compaction**
   - Before compaction, preserve a structured summary containing:
     - Original product requirements and objectives.
     - Architecture decisions and their rationale.
     - Completed and pending implementation phases.
     - Current implementation state.
     - Outstanding tasks and dependencies.
     - Important files, modules and entry points.
     - Technical constraints and coding conventions.
     - Rejected approaches and known issues.
     - Git branch, commit and uncommitted changes.
   - Remove redundant discussions, resolved debugging attempts, repetitive tool outputs and obsolete intermediate findings.
   - Use Claude Code's native compaction mechanism where available rather than implementing a competing mechanism.

3. **Persistent Project Handoff**
   - Maintain or update a structured project handoff/progress document where appropriate.
   - Ensure critical decisions and implementation progress survive session resets and context compaction.
   - Avoid repeatedly rewriting unchanged information.

4. **Subagent Context Isolation**
   - Give subagents only the task-specific context, relevant requirements, constraints and necessary project documentation.
   - Require structured completion reports containing changes, decisions, tests, risks and unresolved issues.
   - Avoid unnecessarily importing complete parent-session histories into subagents.

5. **Session Lifecycle**
   - Continue existing sessions for logically related work.
   - Use fresh sessions for unrelated tasks and independent reviews.
   - Never rely exclusively on conversation history for critical project knowledge.

### Configuration

Support configurable thresholds and enable/disable controls. Initial defaults:

- Proactive compaction: 70–75%.
- Native automatic compaction: enabled.
- Persistent handoff: enabled for long-running workflows.
- Subagent task summaries: mandatory.

### Acceptance Criteria

- Critical product and architectural decisions survive compaction.
- Agents can resume work without repeating unnecessary repository exploration.
- Subagents operate with focused task-specific context.
- Compaction does not interrupt active critical operations.
- Context management reduces redundant token consumption without degrading implementation quality.

**Implementation instruction:** First inspect the existing Software Factory skill architecture, session lifecycle, agent orchestration and context-management capabilities. Integrate this functionality into the existing design rather than creating a duplicate or independent mechanism. Identify platform-specific capabilities and limitations, especially Claude Code's native compaction APIs and context monitoring. Do not assume every agent runtime exposes identical context metrics or compaction controls.
