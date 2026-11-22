# Feature Intake initiative: Phase 1 assessment (draft, read-only)

Status: draft for approval. No implementation file changed. Phases 2 to 7 of the brief (design, integration, quality, utilisation, external research, final plan) are not done yet; sections marked OPEN need them.

## 1. Headline findings

1. **Path A does not exist today.** Every route to a delivery-ready spec runs through product-intelligence:
   - `pi new-feature` refuses unless the opportunity is `Approved` (`pi.mjs:291`).
   - The validator requires each `FEATURE-NNN.md` to carry an `opportunity:` that exists in the registry, and an approved `PRODUCT.md` (`validate-artifacts.mjs:296`).
   - The spec template has 19 market-flavoured sections (business justification, personas, success metrics, research references).
   - So a product owner with known requirements either fakes an opportunity or skips specs. This is the gap the initiative exists to close.
2. **The delivery side is already decoupled.** `delivery-orchestrator` reads only frontmatter (`status`, `delivery`, `depends_on`, `opportunity`) and the title from `.product/features/FEATURE-NNN.md` (`queue.mjs:75`). `opportunity` is read but not required. The implementer treats any spec path as the spec. Feature Intake can therefore write the same files with a relaxed linkage rule and the factory driver, scenarios and merge gates keep working unchanged.
3. **The implementer already has an intake-lite.** For a raw idea it writes a one-page mini-spec (goal, Given/When/Then, non-goals) and asks for approval. That is Path A with no codebase analysis, no edge cases, no dependency ordering. Feature Intake should upgrade this, not sit beside it.
4. **`brainstorming` overlaps Feature Intake in purpose, not in output.** Brainstorming is vendored from obra/superpowers (hash-pinned in `skills.lock.json`), produces a design doc, and hands to `writing-plans`. It was built for open design questions. Feature Intake is for turning a product owner's input into a verifiable spec. They should be routed, not merged; editing the vendored skill would break the lock.
5. **`rough-ideas/skill-governance-&-intelligence-system.md` is a ready-made Path A input** (it already names itself "Feature Intake", ASR-FTR-001) and is also the real requirement behind Phase 5 of the brief. Use it as the first worked example and as the acceptance test.

## 2. Current-state inventory (23 skills, 2 commands)

| Group | Skills | State |
|---|---|---|
| Product | `product-intelligence` (54 files), `growth-strategy` (43), `experience-audit` (20) | Authored, agent-neutral core, claude-code and codex adapters (no Antigravity adapter) |
| Build, own | `implementer`, `delivery-orchestrator` (45 files; factory driver, phases 0 to 2), `skill-insights` | Authored, tested, central |
| Build, vendored (obra/superpowers v7.0.2) | `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `test-driven-development`, `using-git-worktrees`, `finishing-a-development-branch`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `using-superpowers` | Hash-pinned; local edits are not allowed without breaking the lock |
| Review | `pr-review` (quick), `pr-review-orchestrator` (deep), `phased-review`, commands `pr-review`, `deep-pr-review` | Two review tiers plus a third per-plan variant |
| Meta | `autonomous`, `retro` | Imported as-is, relaxed validation |

### Central (used in the main pipeline)
`product-intelligence`, `implementer`, `delivery-orchestrator`, `pr-review-orchestrator`, `skill-insights`, and the vendored build chain (`brainstorming` to `finishing-a-development-branch`).

### Overlaps
- **Two spec-to-code paths:** `implementer` (spec, tiers T0 to T3, ledger) and `writing-plans` + `subagent-driven-development` / `executing-plans` (plan, per-task review). Both do TDD, both review, both run in worktrees. Different inputs, so keep both, but the router must say when to use which (existing guide `build-workflow.md` covers this only informally).
- **Three review entries:** `pr-review`, `pr-review-orchestrator`, `phased-review`. The first two are already selected by effort in their descriptions. `phased-review` overlaps `subagent-driven-development`'s per-task review.
- **Idea to design:** `brainstorming`, `product-intelligence feature <idea>`, and the implementer's mini-spec all start from "I have an idea". No router decides between them.
- **Autonomy:** `autonomous` (zero-question mode), implementer `--unattended`, product-intelligence `full auto`, and the factory driver each define "no human" differently.

### Not integrated into any workflow
- `phased-review`, `autonomous`, `retro`: guide-listed but nothing invokes them.
- `growth-strategy`, `experience-audit`: feed specs to the implementer by handoff files; fine, but they emit spec shapes of their own.
- `skill-insights`: reads Claude Code transcripts only. Nothing reads Antigravity or Codex history.

### Cross-platform
Only `using-superpowers` carries Antigravity notes (`references/antigravity-tools.md`). No skill has an Antigravity adapter. Agent-neutral `core/` plus `SKILL.md` is the existing portability mechanism and Antigravity reads the Agent Skills format, so a Feature Intake skill built in the same shape is plausible, but this is unverified; Phase 6 research must confirm Antigravity's skill discovery, subagent and hook model before any claim.

## 3. Spec-format compatibility (answers the brief's `.product/features/` question)

| Consumer | What it needs from a spec | Breaks if Feature Intake writes it? |
|---|---|---|
| `delivery-orchestrator` queue | filename `FEATURE-NNN.md`, `status: ready`, optional `delivery`, `depends_on`, `opportunity` | No |
| `implementer` | Given/When/Then criteria, any path; close-out adds `delivery:` and a Delivery log, and runs `pi transition <OPP>` only if an opportunity exists | Close-out step needs a no-opportunity branch (small doc change) |
| factory scenario author (Phase 1) | acceptance criteria text | No (needs check that it does not assume the 19 section names; OPEN) |
| `pi validate` | `opportunity` in registry, 19 sections, approved PRODUCT.md | **Yes.** It would flag Path A specs as errors |

Conclusion: `.product/features/` can host both, if the validator accepts a spec whose `origin` is `intake` (no opportunity, no PRODUCT.md approval, a smaller required section set) and keeps full rules for `origin: product-intelligence`. This is the one change to existing validated code, and it must keep every current fixture passing.

## 4. Gaps against the brief

| Brief item | State |
|---|---|
| Intake for rough ideas, plans, bug reports | Missing. Implementer mini-spec covers only raw ideas, thinly |
| Codebase analysis for the spec | Only inside product-intelligence handoff (needs approved baseline) |
| Readiness states independent of market validation | Missing. Status `ready` is tied to the opportunity lifecycle |
| Superpowers plan as an input | Missing. `writing-plans` output cannot become a spec |
| Risk-based reviews (security, database lens) | Present inside implementer T3 and `pr-review-orchestrator`; not triggered by spec content |
| Post-merge validation | Phase 6 of the factory roadmap, not started |
| Skill utilisation | `skill-insights inventory` exists (used or never used, Claude Code only); duplicate and overlap detection is the unbuilt part, specified in `rough-ideas/skill-governance-...md` |

## 5. Early recommendations (for the design phase, not decisions)

1. **One new skill, `feature-intake`**, in the standard shape (`SKILL.md`, `core/`, references, templates, adapters), one helper `fi.mjs` for IDs and readiness checks. It reuses `pi`'s ID allocation and section checker by copying, per the repo rule against shared code.
2. **A small spec schema, not 19 sections.** Brief section list maps to about 12 required sections; the rest optional by risk tier. Keep `FEATURE-NNN.md` and the same frontmatter keys so the queue works.
3. **Readiness is mechanical**: `draft`, `needs-clarification`, `ready`. `ready` requires testable criteria, bounded scope, no `[BLOCKING]` items, named verification, and for T3 a security/database lens recorded. Approval stays a human act recorded with the user's words, as `pi decide` does.
4. **Product-intelligence stays optional.** Path B hands an approved opportunity to Feature Intake instead of `pi handoff` writing its own 19-section spec; or `pi handoff` keeps working and Feature Intake accepts its output as already complete. Decide in design; the second is smaller.
5. **No new orchestrator.** Routing is a short table in `feature-intake` and `docs/guides/README.md`: known requirements go to intake, open design goes to brainstorming, market questions go to product-intelligence, then everything converges on the implementer and the delivery driver.
6. **Skill governance as extension of `skill-insights`**, not a new skill: add overlap and duplicate detection (name, description and section similarity, local only) to `si inventory`, and an Antigravity transcript reader only after Phase 6 confirms where that data lives.
7. **Deprecation candidates, pending usage evidence:** `phased-review` (overlaps subagent-driven-development), and folding `pr-review` into `pr-review-orchestrator` as an effort level. Do not remove anything without `si inventory` numbers.

## 6. Open questions for you

- Should `feature-intake` replace the implementer's mini-spec path entirely, or leave it for one-line T0/T1 asks? (Recommend: keep mini-spec for T0/T1.)
- Is a relaxed validator (`origin: intake`) acceptable, or must intake specs live in a separate folder such as `.product/intake/`? A separate folder means a queue change and a second validator.
- Antigravity: do you want a working adapter in the first milestone, or core-neutral now and adapter after research?
- Factory work: roadmap Phase 3 onward are outlines. Intake fits before Phase 3 (scenario author consumes the criteria). Pause the phase 3 to 8 re-spec until this lands?

## 7. Not done yet (per the brief)

Phase 2 design in full (schema, examples, diagrams), Phase 3 per-skill integration decisions, Phase 4 quality changes, Phase 5 design, Phase 6 external research and citations, Phase 7 final plan and backlog. Approval needed on the direction in section 5 before Phase 2 design starts.
