# Feature Intake: Skill Governance & Intelligence System

**Feature ID:** ASR-FTR-001  
**Status:** Proposed / Backlog  
**Priority:** Medium  
**Category:** Developer Productivity / AI Agent Infrastructure  
**Target Repository:** `sourav-ojha/agent-skills`  
**Document Type:** Feature Intake & Product Discovery  
**Created:** 21 November 2026

---

## 1. Executive Summary

### Problem Statement

As AI-assisted development workflows grow, the number of installed and personally maintained skills increases rapidly.

Skills are created, downloaded, modified, copied between AI coding agents and installed at different scopes. Over time, this creates several problems:

- Multiple skills perform nearly identical tasks.
- Different skills have overlapping responsibilities.
- Some skills become outdated or superseded.
- Unused skills remain installed indefinitely.
- The same skill may exist in multiple locations or versions.
- Skills consume context and token budget without providing proportional value.
- There is no unified visibility into which skills are actually used.
- Maintaining consistency across Claude Code, Antigravity and other supported environments becomes difficult.

Currently, cleaning this ecosystem requires manually inspecting skill definitions, understanding their responsibilities, checking usage history and deciding what to retain.

This feature proposes building a **Skill Governance & Intelligence System** that audits both the maintained skill repository and locally installed runtime skills.

### Product Vision

Build a unified system that continuously helps developers understand:

1. What skills do I have?
2. What does each skill actually do?
3. Which skills are being used?
4. Which skills are duplicates or functionally overlapping?
5. Which skills are outdated or redundant?
6. Which skills should be merged, improved, archived or retained?
7. How healthy is my overall skill ecosystem?

The system should provide actionable recommendations backed by evidence, rather than blindly deleting or modifying skills.

---

## 2. Goals and Non-Goals

### Goals

- Audit skills maintained in Git repositories.
- Discover installed skills across supported AI coding environments.
- Analyze skill usage from available runtime histories.
- Detect exact duplicates and semantic overlaps.
- Identify skills that are subsets or supersets of other skills.
- Identify outdated, unused and potentially obsolete skills.
- Detect poor skill structure and instruction quality.
- Recommend consolidation opportunities.
- Provide safe, reversible cleanup workflows.
- Generate machine-readable and human-readable reports.
- Support periodic audits as the skill ecosystem evolves.

### Non-Goals (Initial Scope)

- Building a marketplace for discovering or distributing skills.
- Automatically rewriting all skills.
- Automatically deleting skills based on usage scores.
- Replacing Claude Code or Antigravity's native skill discovery mechanisms.
- Building a general-purpose AI agent management platform.
- Synchronizing skill files across agents automatically.
- Enforcing a particular AI model or provider.

---

## 3. Two Governance Domains

The system must operate across two distinct but connected domains.

### A. Repository Governance

This concerns skills maintained in our GitHub repository.

Example:

`github.com/sourav-ojha/agent-skills`

Responsibilities:

- Discover all skill directories.
- Parse SKILL.md and supporting files.
- Extract skill metadata and intended responsibilities.
- Identify duplicate and overlapping functionality.
- Detect skills with similar triggers and descriptions.
- Identify outdated or redundant instructions.
- Analyze relationships between skills.
- Recommend repository restructuring.
- Maintain a historical record of audit findings.

Example finding:

Two skills may have different names:

- `growth-strategy`
- `seo-growth-planner`

However, both might contain almost identical research, keyword planning, competitor analysis and content strategy workflows.

The system should recognize their functional overlap and recommend whether to merge them, separate their responsibilities or establish a parent workflow.

### B. Runtime Governance

This concerns skills installed and available in local AI coding environments.

Potential environments:

- Claude Code
- Google Antigravity
- Cursor
- Codex
- Other compatible agent environments in the future

Responsibilities:

- Discover installed skill directories.
- Identify skill installation sources.
- Detect duplicate installations.
- Collect runtime usage history.
- Identify unused or stale skills.
- Understand global versus project-level installations.
- Detect marketplace-managed versus user-managed skills.
- Analyze approximate context/token overhead.
- Recommend safe archival or cleanup.

Example finding:

`code-review` exists in:

- Global Claude Code skills.
- Project-level Claude Code skills.
- Antigravity skills.
- A marketplace plugin.

The system should determine whether these are identical copies, different versions or intentionally separate implementations.

**Important:** A skill being installed in multiple environments is not necessarily duplication. It may be intentional cross-agent portability.

---

## 4. Proposed Feature Modules

### Module 1: Skill Discovery & Inventory

Build a unified inventory of all discovered skills.

Required capabilities:

- Recursive directory scanning.
- SKILL.md discovery.
- YAML frontmatter parsing.
- Skill name and description extraction.
- Supporting resource discovery.
- Installation path identification.
- Source identification.
- Agent/environment identification.
- Last modified timestamp.
- File size and approximate token estimation.
- Duplicate installation detection.

Each skill should have a normalized representation.

Suggested metadata:

| Field          | Description                                |
| -------------- | ------------------------------------------ |
| skill_id       | Stable internal identifier                 |
| name           | Skill name                                 |
| description    | Declared description                       |
| source         | Git repository, local, plugin, marketplace |
| environment    | Claude, Antigravity, Cursor, etc.          |
| scope          | Global, project, plugin                    |
| path           | Actual filesystem location                 |
| content_hash   | Exact content fingerprint                  |
| modified_at    | Last modification                          |
| usage_status   | Used, unused, unknown                      |
| usage_count    | Recorded invocations                       |
| last_used_at   | Last observed invocation                   |
| token_estimate | Approximate size                           |

### Module 2: Usage Analytics

Understand how frequently skills are actually invoked.

Required metrics:

- Total invocation count.
- Unique sessions using the skill.
- Last used timestamp.
- Usage frequency over configurable periods.
- Usage by project.
- Usage by environment.
- Explicit versus inferred invocation.
- Usage confidence.
- Approximate token consumption where measurable.

Potential usage categories:

- Frequently used.
- Occasionally used.
- Rarely used.
- Never observed.
- Usage unknown.

**Critical distinction:** Never observed does not mean never used.

Some environments expose invocation events, while others require parsing session histories. Automatically triggered skills may not generate an explicit skill invocation event.

The system must track how usage was detected and its confidence.

### Module 3: Duplicate & Semantic Overlap Detection

This is the core intelligence module.

It must go beyond comparing filenames and descriptions.

#### Detection levels

**Level 1: Exact duplicates**

- Identical file content.
- Identical content hashes.
- Identical supporting resources.

**Level 2: Structural duplicates**

- Same workflow with different wording.
- Similar instructions and execution steps.
- Same inputs and expected outputs.

**Level 3: Semantic duplicates**

- Different names but equivalent responsibilities.
- Different descriptions but similar execution objectives.
- Different wording that produces substantially similar outcomes.

**Level 4: Functional overlap**

- Skills share some responsibilities.
- One skill is a subset of another.
- Two skills overlap in certain workflow stages.
- Skills should share common capabilities without being merged.

#### Required relationship classifications

| Relationship         | Meaning                             | Potential action       |
| -------------------- | ----------------------------------- | ---------------------- |
| Exact duplicate      | Same content                        | Keep one copy          |
| Functional duplicate | Same outcome and workflow           | Merge candidate        |
| High overlap         | Substantial shared responsibilities | Review / merge         |
| Partial overlap      | Shared capabilities, distinct goals | Refactor boundaries    |
| Subset               | One skill is contained in another   | Extract or consolidate |
| Complementary        | Different skills work together      | Keep both              |
| Independent          | Different responsibilities          | Keep both              |

#### Example

| Skill A           | Skill B             | Detected relationship | Recommendation      |
| ----------------- | ------------------- | --------------------- | ------------------- |
| SEO Audit         | Technical SEO Audit | High overlap          | Investigate merge   |
| PR Review         | Security Review     | Partial overlap       | Keep separate       |
| Growth Strategy   | SEO Growth Planner  | Functional overlap    | Refactor boundaries |
| API Documentation | OpenAPI Generator   | Complementary         | Keep both           |

The analysis must explain _why_ a relationship was detected.

Similarity percentages alone are insufficient evidence.

### Module 4: Skill Quality & Health Audit

Analyze the quality of individual skills.

Potential checks:

- Missing or invalid frontmatter.
- Missing descriptions.
- Poorly defined trigger conditions.
- Ambiguous responsibilities.
- Excessively broad scope.
- Excessively large SKILL.md files.
- Duplicate instructions.
- Contradictory instructions.
- Missing workflow steps.
- Missing expected output definitions.
- Broken references to supporting files.
- Outdated commands and dependencies.
- Unnecessary context consumption.
- Poor separation of reusable resources and core instructions.

Generate individual quality findings with severity:

- Critical
- High
- Medium
- Low
- Informational

Do not treat file size alone as proof of poor quality.

### Module 5: Skill Lifecycle Management

Introduce a standard lifecycle for skill maintenance.

Possible states:

- Active
- Review required
- Consolidation candidate
- Deprecated
- Archived
- Disabled
- Unknown

Recommended actions:

| Action   | Description                               |
| -------- | ----------------------------------------- |
| KEEP     | Skill is useful and healthy               |
| UPDATE   | Skill needs improvements                  |
| MERGE    | Consolidate with another skill            |
| SPLIT    | Separate unrelated responsibilities       |
| REFACTOR | Clarify scope and workflow                |
| ARCHIVE  | Preserve but remove from active discovery |
| DELETE   | Remove only after explicit approval       |

The system should never automatically delete a skill based solely on inactivity or similarity.

### Module 6: Governance Dashboard & Reports

Provide a clear overview of the skill ecosystem.

Suggested dashboard sections:

1. Total skills discovered.
2. Skills grouped by environment.
3. Usage distribution.
4. Unused and stale skills.
5. Duplicate groups.
6. Semantic overlap candidates.
7. Quality audit findings.
8. Token/context overhead.
9. Recommended cleanup actions.
10. Historical audit trends.

Required outputs:

- Markdown report.
- JSON report.
- Interactive HTML dashboard (future enhancement).
- Optional CSV export.

Reports should be useful to both humans and AI agents.

---

## 5. Competitive Research & Reference Implementations

The following projects should be studied before implementing our own solution.

The intention is to reuse proven approaches where appropriate rather than reinventing existing capabilities.

### Reference 1: Stack Cleaner

Repository / Website:

https://stackcleaner.com/

**What it offers:**

- Discovers Claude Code skills, plugins, agents and MCP servers.
- Separates global and project-level installations.
- Provides usage counts.
- Identifies duplicate configurations.
- Generates a local inventory report.
- Emphasizes local processing and privacy.

**What we should learn:**

- Inventory discovery approach.
- Global versus project scope handling.
- Usage reconciliation.
- Unified ecosystem inventory.
- Privacy-first architecture.

**Limitations / opportunities:**

- Primarily Claude Code-oriented.
- Not a comprehensive cross-agent skill governance system.
- Semantic skill relationship analysis needs deeper investigation.
- Repository-level governance is not its central focus.

**Potential reuse:** Inventory architecture and discovery approach.

### Reference 2: Skill Usage Stats

Repository:

https://github.com/cskwork/skill-usage-stats

Website:

https://cskwork.github.io/skill-usage-stats/

**What it offers:**

- Parses Claude Code and Codex transcripts.
- Tracks explicit and inferred skill invocations.
- Tracks usage frequency and last-used dates.
- Generates an interactive HTML dashboard.
- Provides KEEP / REVIEW / DELETE classifications.
- Supports reversible archiving.

**What we should learn:**

- Transcript parsing.
- Usage-event detection.
- Reconciliation between usage records and installed skills.
- Handling of automatic skill invocation.
- Dashboard design.
- Reversible archival mechanism.

**Limitations / opportunities:**

- Focused on Claude Code and Codex.
- Does not provide comprehensive semantic duplicate analysis.
- Usage detection depends on accessible local history.
- Some automatic invocation patterns may remain difficult to observe.

**Potential reuse:** Usage analytics and archive workflow.

### Reference 3: Skills Cleaner — amebahead

Repository:

https://github.com/amebahead/skills-cleaner

**What it offers:**

- Tracks skill usage.
- Reports token consumption and execution duration.
- Provides skill inventory and search.
- Compares skills for similarity.
- Guides users through duplicate cleanup.
- Uses a similarity-based review process.

**What we should learn:**

- Skill comparison workflow.
- Usage profiling.
- Token consumption reporting.
- Human-in-the-loop cleanup.
- Interactive review of duplicate pairs.

**Limitations / opportunities:**

- Claude Code plugin-centric.
- Cross-agent support is not established.
- Similarity thresholds should not be treated as proof of functional duplication.
- Direct deletion of personal skill directories needs stronger safeguards.

**Potential reuse:** Interactive semantic comparison and usage profiling.

### Reference 4: Skill Cleaner — trleo

Repository:

https://github.com/trleo/skill-cleaner

**What it offers:**

- Supports Claude Code, Cursor and Antigravity.
- Finds exact-name duplicates.
- Detects exact-content duplicates.
- Identifies keyword-overlap candidates.
- Supports supplied usage history.
- Generates Markdown and JSON reports.
- Uses approval files and quarantine.
- Supports restoration.

**What we should learn:**

- Cross-agent directory discovery.
- Tool-specific adapters.
- Unified skill inventory.
- Duplicate detection signals.
- Explicit approval files.
- Quarantine and restore.
- Standard-library-first implementation.

**Limitations / opportunities:**

- Early-stage project with limited community adoption.
- Semantic analysis is relatively basic.
- Usage detection requires supplied history.
- Does not prove that overlapping skills are interchangeable.
- Does not offer deep skill quality governance.

**Potential reuse:** Cross-agent architecture and safe cleanup workflow.

### Reference 5: Claude Skill Cleaner — YuzuruS

Repository:

https://github.com/YuzuruS/claude-skill-cleaner

**What it offers:**

- Read-only audit of Claude Code skills and subagents.
- Detects active versus inactive skill copies.
- Analyzes plugin installation paths.
- Identifies duplicate and outdated copies.
- Reports usage from session logs.
- Estimates skill prompt overhead.
- Generates JSON output.

**What we should learn:**

- Active versus discovered skill distinction.
- Marketplace/cache duplicate handling.
- Plugin installation metadata.
- Context budget estimation.
- Read-only audit architecture.

**Limitations / opportunities:**

- Claude Code-specific.
- Requires a recent Node.js version.
- Usage analysis is not comprehensive semantic governance.
- Token estimates are approximations, not actual model billing or context consumption.

**Potential reuse:** Installation-source reconciliation and context overhead analysis.

### Additional Reference: agent-scripts / skill-cleaner

Repository:

https://github.com/steipete/agent-scripts

Study the original skill-cleaner implementation and its approach to auditing skill installations and usage.

It is also useful for understanding how the ideas in Claude-specific ports evolved.

---

## 6. Competitive Feature Matrix

| Capability                | Stack Cleaner | Usage Stats  | amebahead           | trleo             | YuzuruS        |
| ------------------------- | ------------- | ------------ | ------------------- | ----------------- | -------------- |
| Inventory discovery       | Yes           | Yes          | Yes                 | Yes               | Yes            |
| Usage analytics           | Yes           | Yes          | Yes                 | History-dependent | Yes            |
| Cross-agent support       | Limited       | Claude/Codex | Limited             | Yes               | No             |
| Exact duplicate detection | Yes           | Limited      | Similarity          | Yes               | Yes            |
| Semantic overlap          | Limited       | No           | Yes                 | Basic             | Limited        |
| Skill quality audit       | Limited       | No           | Limited             | No                | Limited        |
| Token overhead            | Limited       | Yes          | Yes                 | No                | Yes            |
| Safe archival             | Limited       | Yes          | Interactive cleanup | Yes               | Read-only      |
| Restore                   | Investigate   | Yes          | Investigate         | Yes               | Not applicable |
| JSON reporting            | Yes           | Yes          | Yes                 | Yes               | Yes            |

_Matrix reflects publicly documented functionality, not independent performance testing. Features and support may change._

---

## 7. Proposed Architecture

The system should be modular and provider-independent.

### Conceptual architecture

```text
                 SKILL GOVERNANCE
                         |
             +-----------+-----------+
             |                       |
       Repository Scanner       Runtime Scanner
             |                       |
       GitHub / Local Repo      Local Environments
             |                       |
             +-----------+-----------+
                         |
                  Normalization
                         |
               Unified Skill Registry
                         |
             +-----------+-----------+
             |           |           |
          Usage       Duplicate    Quality
         Analyzer     Analyzer     Analyzer
             |           |           |
             +-----------+-----------+
                         |
                 Governance Engine
                         |
              Recommendation Engine
                         |
             +-----------+-----------+
             |                       |
          Reports                Cleanup Workflow
          Dashboard              Quarantine/Restore
```

### Proposed internal components

**1. Scanner Layer**

- Repository scanner.
- Local filesystem scanner.
- Environment-specific adapters.
- History/transcript scanner.

**2. Normalization Layer**

Convert different agent-specific skill formats into a unified internal representation.

**3. Analysis Layer**

- Exact duplicate detector.
- Structural similarity detector.
- Semantic similarity analyzer.
- Usage analyzer.
- Quality analyzer.
- Lifecycle analyzer.

**4. Governance Layer**

Combines findings and creates recommendations.

**5. Output Layer**

- CLI.
- Markdown report.
- JSON report.
- HTML dashboard.

### Important architectural principle

Do not couple the core analysis engine to Claude Code.

Use adapters for each environment. This will allow future integrations without rewriting the governance engine.

---

## 8. Technology Considerations

These are initial suggestions, not final technology decisions.

| Area                      | Potential technology                    |
| ------------------------- | --------------------------------------- |
| Core CLI                  | Python or Node.js                       |
| Filesystem scanning       | Native filesystem APIs                  |
| Metadata parsing          | YAML/frontmatter parser                 |
| Transcript processing     | JSONL parsers                           |
| Exact duplicate detection | SHA-256                                 |
| Structural comparison     | Normalized text and AST-like comparison |
| Semantic analysis         | LLM-based evaluation                    |
| Embedding similarity      | Optional embedding provider             |
| Reports                   | Markdown and JSON                       |
| Dashboard                 | Static HTML                             |
| Testing                   | Unit and integration tests              |

### AI analysis strategy

Do not send every skill pair to an LLM.

Use a staged approach:

1. Exact hash comparison.
2. Metadata and description similarity.
3. Keyword and structural similarity.
4. Identify likely overlap candidates.
5. Send only relevant candidates for semantic analysis.
6. Ask the model to explain functional similarities and differences.
7. Produce evidence-backed recommendations.

This keeps cost and latency under control.

LLM analysis should be optional. Exact duplicate detection, inventory discovery and basic quality checks should work offline.

---

## 9. Safety, Privacy and Data Handling

The system will inspect local development environments and potentially sensitive session histories.

Requirements:

- Local-first operation.
- No automatic telemetry.
- No transcript uploads by default.
- Never expose API keys, credentials or environment variables in reports.
- Avoid storing raw conversation histories.
- Store only aggregated usage metadata when possible.
- Explicit configuration for any external AI provider.
- Exclude marketplace-managed files from direct modification.
- Default to read-only auditing.
- Never delete files automatically.
- Require explicit approval before cleanup.
- Support dry-run mode.
- Support quarantine and restore.
- Preserve original paths and metadata.
- Handle symlinks and path traversal safely.

**Non-negotiable:** A cleanup recommendation must never become an automatic destructive action.

---

## 10. Proposed User Experience

### Example commands

```bash
# Scan repository skills
skill-governance repo scan

# Scan locally installed skills
skill-governance runtime scan

# Scan both
skill-governance scan --all

# Analyze usage history
skill-governance usage analyze

# Find duplicate and overlapping skills
skill-governance duplicates analyze

# Perform quality checks
skill-governance quality audit

# Generate a complete report
skill-governance audit --all

# Export machine-readable results
skill-governance report --format json

# Preview cleanup actions
skill-governance cleanup --dry-run

# Quarantine approved skills
skill-governance cleanup --approve approvals.json

# Restore archived skills
skill-governance restore <archive-id>
```

These commands are illustrative. CLI design should be finalized during technical discovery.

### Example audit report

```text
SKILL GOVERNANCE REPORT

Repository Skills:              42
Installed Runtime Skills:       87
Unique Skills:                  71

USAGE
Frequently Used:                18
Occasionally Used:              21
Rarely Used:                    12
Never Observed:                 14
Usage Unknown:                  22

DUPLICATION
Exact Duplicates:                5
High Functional Overlap:         7
Partial Overlap:                11
Independent Skills:             48

QUALITY
Critical Findings:               1
High Findings:                   4
Medium Findings:                 8

RECOMMENDATIONS
Keep:                           52
Update:                           9
Merge Candidates:                 5
Review:                           7
Archive Candidates:               4
```

_Illustrative output only._

### Example recommendation

```text
OVERLAP DETECTED

Skill A: growth-strategy
Skill B: seo-growth-planner

Relationship: High Functional Overlap

Shared Responsibilities:
- Competitor analysis
- Keyword research
- Organic traffic planning
- Content strategy

Differences:
- growth-strategy includes broader acquisition channels.
- seo-growth-planner focuses on technical and organic SEO.

Recommendation: REFACTOR

Suggested Approach:
1. Keep growth-strategy as the broader strategic workflow.
2. Extract reusable SEO-specific workflows.
3. Retain seo-growth-planner if it provides independent execution value.
4. Remove duplicated instructions.

Confidence: High

Evidence:
- Shared workflow stages
- Similar input requirements
- Overlapping output definitions
- Similar execution instructions
```

---

## 11. Phased Implementation Roadmap

### Phase 0 — Research and Technical Discovery

- Inspect all reference repositories.
- Evaluate licenses and reuse restrictions.
- Understand agent-specific skill discovery conventions.
- Study available transcript formats.
- Evaluate semantic comparison approaches.
- Establish supported environments.
- Define the unified skill schema.

**Deliverable:** Technical discovery report and architecture decision record.

### Phase 1 — Inventory and Exact Duplicate Detection

- Repository scanning.
- Runtime directory scanning.
- Frontmatter parsing.
- Cross-agent skill normalization.
- Exact duplicate detection.
- Markdown and JSON reports.

**Deliverable:** Read-only skill inventory CLI.

### Phase 2 — Usage Analytics

- Claude Code history parser.
- Antigravity usage investigation and adapter.
- Other agent adapters where supported.
- Invocation frequency.
- Last-used timestamps.
- Usage confidence.
- Project-level usage analysis.

**Deliverable:** Usage analytics and runtime dashboard data.

### Phase 3 — Intelligent Duplicate Analysis

- Structural comparison.
- Description similarity.
- Functional responsibility extraction.
- Semantic comparison.
- Subset/superset detection.
- Relationship classification.
- Evidence-backed recommendations.

**Deliverable:** Intelligent overlap analysis.

### Phase 4 — Quality and Lifecycle Governance

- Skill quality checks.
- Outdated skill identification.
- Scope and responsibility analysis.
- Context overhead estimates.
- Lifecycle recommendations.
- Historical audit comparisons.

**Deliverable:** Comprehensive governance reports.

### Phase 5 — Safe Cleanup

- Approval-based cleanup.
- Dry-run execution.
- Quarantine.
- Restore.
- Managed-skill protection.
- Cleanup audit history.

**Deliverable:** Reversible skill lifecycle management.

### Phase 6 — Dashboard and Automation

- Interactive HTML dashboard.
- Historical trend analysis.
- Repository audit integration.
- Optional GitHub Actions workflow.
- Scheduled audit support.
- Pull request recommendations.

**Deliverable:** Complete Skill Governance System.

---

## 12. Acceptance Criteria

The feature should be considered successful when:

1. It can scan the maintained skill repository and discover all valid skills.
2. It can discover installed skills across supported environments.
3. It distinguishes global, project and plugin-managed installations.
4. It identifies exact duplicates reliably.
5. It can detect semantically similar skills with explanations.
6. It distinguishes functional duplicates from complementary skills.
7. It can analyze usage from supported runtime histories.
8. It differentiates never-used from usage-unknown.
9. It generates actionable quality findings.
10. It produces Markdown and JSON reports.
11. It provides recommendations without modifying source files.
12. It can quarantine explicitly approved skills.
13. It can restore quarantined skills.
14. It never modifies marketplace-managed installations without an explicitly supported safe workflow.
15. It works without an external LLM for basic auditing.
16. It supports adding new environment adapters without changing the core analysis engine.

---

## 13. Risks and Open Questions

| Question / Risk           | Investigation Required                                              |
| ------------------------- | ------------------------------------------------------------------- |
| Antigravity usage history | Determine whether reliable invocation logs are accessible           |
| Auto-triggered skills     | Determine how to distinguish actual use from simple file reads      |
| Cross-agent compatibility | Define environment-specific adapters and schemas                    |
| Semantic false positives  | Establish confidence levels and human review                        |
| Token estimation          | Separate approximate context overhead from actual token consumption |
| Plugin-managed skills     | Avoid modifying managed installations                               |
| Large repositories        | Optimize pairwise comparison and use candidate filtering            |
| LLM cost                  | Use staged analysis and optional provider configuration             |
| Historical analysis       | Decide what metadata needs to persist between audits                |
| Skill versioning          | Determine how to compare repository and installed versions          |

---

## 14. Product Success Metrics

Potential metrics:

- Percentage of installed skills successfully discovered.
- Percentage of usage events correctly reconciled.
- Duplicate detection precision.
- Semantic overlap recommendation acceptance rate.
- Number of redundant skills identified.
- Number of outdated skills identified.
- Number of successful safe cleanup operations.
- Number of restored skills after cleanup.
- Average audit execution time.
- Cost per semantic audit.

Avoid optimizing for the number of deleted skills. The goal is a healthier ecosystem, not a smaller skill count.

---

## 15. Initial Scope Recommendation

Do not attempt to build everything in the first iteration.

The recommended initial MVP should include:

1. Repository skill discovery.
2. Runtime skill discovery for Claude Code and Antigravity.
3. Unified inventory.
4. Exact duplicate detection.
5. Basic usage analytics where history is accessible.
6. Markdown and JSON reports.
7. Initial semantic overlap analysis.
8. Read-only recommendations.

Defer dashboard polish, advanced quality scoring, automated cleanup and scheduled governance until the core analysis engine is reliable.

**Most important engineering decision:** Keep the analysis engine independent of the CLI, dashboard and agent-specific integrations. This is what will allow the feature to evolve into a reusable tool rather than becoming a collection of scripts.

---

## 16. Reference Links & Research Checklist

Before implementation, agents should inspect these repositories directly.

| Project              | Reference                                       | Primary learning area               |
| -------------------- | ----------------------------------------------- | ----------------------------------- |
| Stack Cleaner        | https://stackcleaner.com/                       | Ecosystem inventory                 |
| Skill Usage Stats    | https://github.com/cskwork/skill-usage-stats    | Usage analytics                     |
| Skills Cleaner       | https://github.com/amebahead/skills-cleaner     | Semantic comparison                 |
| Skill Cleaner        | https://github.com/trleo/skill-cleaner          | Cross-agent scanning and quarantine |
| Claude Skill Cleaner | https://github.com/YuzuruS/claude-skill-cleaner | Active installations and overhead   |
| agent-scripts        | https://github.com/steipete/agent-scripts       | Original cleanup implementation     |

Research checklist:

- [ ] Inspect source code and architecture.
- [ ] Review licenses before reusing code.
- [ ] Identify reusable algorithms and parsers.
- [ ] Inspect test coverage.
- [ ] Compare installation discovery strategies.
- [ ] Investigate supported transcript formats.
- [ ] Evaluate duplicate detection accuracy.
- [ ] Evaluate semantic comparison quality.
- [ ] Identify unsupported environments.
- [ ] Document what should be reused versus independently implemented.

---

## 17. Final Product Direction

The proposed feature should become a reusable capability within the `agent-skills` ecosystem.

Its long-term purpose is to make AI agent skills maintainable, discoverable, measurable and reliable.

The system should answer four important questions:

**Discovery:** What skills exist across my repositories and development environments?

**Intelligence:** Which skills are useful, redundant, overlapping or outdated?

**Governance:** What should I keep, improve, merge or archive?

**Evolution:** How does my skill ecosystem change over time?

The end goal is not simply cleaning up skills.

It is establishing a sustainable governance layer for the growing AI agent ecosystem.

**Recommended status: PROPOSED — Add to the feature backlog. Do not begin implementation until Phase 0 research and technical discovery are complete.**
