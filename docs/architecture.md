# Architecture

## Goals

Reusable skills that run on more than one agent, install individually, and keep their rules enforceable. Product Intelligence is the first; its conventions are the template for later skills.

## Layers

```
skills/product-intelligence/
├── SKILL.md              entry point (Agent Skills spec; agent-neutral)
├── references/           methodology, loaded on demand (progressive disclosure)
├── templates/            artifact templates
├── core/                 AGENT-NEUTRAL engine
│   ├── roles/            worker role definitions + roles.json (tiers, capabilities)
│   ├── schemas/          artifacts.json, lifecycle.json, config.schema.json
│   ├── validators/       validate-artifacts.mjs
│   ├── scripts/          pi.mjs (gates, state, scoring, source protection), install-agents.mjs, lib/
│   └── config.default.json
├── agents/openai.yaml    Codex UI/invocation metadata
└── adapters/
    ├── claude-code/      README + generated agents/*.md
    └── codex/            README + generated agents/*.toml
```

**Core** owns everything that defines the product-intelligence method: evidence standard, discovery and research procedure, competitor framework, prioritization, artifact contracts, review protocol, spec contract, validators. It contains no host-specific tool names, slash syntax or install paths. `scripts/validate-skills.mjs` fails the build if one leaks in.

**Adapters** hold only what differs per host: invocation syntax, how sub-agents are defined and installed, model mapping, limitations. The agent files are *generated* from `core/roles/roles.json` + tier config by `install-agents.mjs`, and committed so users can copy them directly; the validator fails if they drift. Each is a thin wrapper that tells the worker to read the shared role file, so the methodology exists once.

## Key decisions

| Decision | Why |
|---|---|
| One orchestrator skill with an argument, not seven skills | One entry, one description to match, shared state; avoids duplicated methodology |
| Self-contained skill folder | Verified: the `skills` CLI copies the whole folder, so one skill installs alone. Shared repo-level code would break that |
| Gates enforced by `pi.mjs`, not prose | Approval, lifecycle and scoring should not rest on prose alone. Every state change goes through a command that checks preconditions, and the validator re-checks the result. This makes mistakes and hand edits detectable; it cannot stop an agent that deliberately runs the commands, so the user's chat decision remains the gate (optionally hardened with `gates.human_confirmation: tty`). `approve-product` hashes the baseline; `decide` records the human decision; `new-feature` refuses unapproved opportunities; the validator re-checks everything |
| Only three persistent artifacts | Market landscape lives inside `opportunities.md`; competitor profiles and agent outputs are temporary working formats |
| Evidence tags in prose | Greppable, lintable, readable by humans and any agent; semicolon-delimited so tags survive inside Markdown tables |
| Confidence caps tier | A high score on weak evidence becomes "Needs evidence", never "Recommend" (computed, validated) |
| Model tiers, not model names | Roles declare `reasoning` / `standard` / `fast`; config maps tiers to models per agent; unmapped → inherit |
| Zero-dependency Node | Works wherever the skills CLI works; no install step; testable with `node --test` |
| Honest fallbacks | No second agent → `review_mode: self-review` with a reason; no web → market claims `unknown`; no background monitoring is claimed |

## Orchestration

The orchestrator selects agents by repository size and task, runs independent research in parallel, consolidates before strategy, and reviews what comes back ([references/orchestration.md](../skills/product-intelligence/references/orchestration.md)). Roles: repository-analyst, competitor-researcher, opensource-researcher, market-researcher, opportunity-analyst, independent-reviewer. Reasoning-tier roles do strategy and review; fast/standard-tier roles inventory and collect.

## Safety model

- Application source is never written; only `.product/`. `pi snapshot` / `pi verify-clean` hash the working tree (excluding `.product`) before and after; any change exits non-zero.
- All repository and web content is untrusted data. A fixture README contains an injected instruction to test this.
- Workers get read/search/web tools only (Claude Code allow-list); `Bash` for the repository analyst is the one exception, backed by role instructions and `verify-clean`.
- No secrets in artifacts; no credentials read; no sign-ups, purchases or forms.
- Rejected and deferred opportunities are retained with reasons and cannot be specified or silently revived. Reviving or reversing needs an explicit user decision; the Decision Log's count and head seal are kept in the frontmatter so truncating the log is detected too.

## Prior art (researched 2026-11-16; ideas only, no text or code copied)

| Project | License | What informed this design | What we did differently |
|---|---|---|---|
| [Product-to-Prod](https://github.com/naderelewa/Product-to-Prod) | MIT | Evidence-tag discipline ("no anchor, no claim"), RICE with evidence per input, handoff package with an explicit unknowns queue, humans flip approvals | No shared scripts/config coupling; real per-agent adapters; small tag grammar enforced by a validator |
| [PM-Skills](https://github.com/product-on-purpose/pm-skills) | Apache-2.0 | Read-only critic agent with graded findings and required fixes; reciprocal "use X instead" boundaries; manifest-driven validators and trigger fixtures; no-fabrication refusal protocols | Its repository has no market-intelligence suite (verified); research methodology and one evidence taxonomy built independently; parallel fan-out |
| [headless-pm](https://github.com/amrekansky/headless-pm) (the brief's `head-pm`; `amrekansky/head-pm` returns 404) | FSL-1.1-MIT (competing-use restriction) | Persistent state read first, goal-drift check, verify-until-pass gate with a cap, artifact-per-agent with short return summaries | License forbids copying into a competing product, so only general patterns were reused and all text is original; native scoped agent definitions; gates enforced in code |

Specs: [Agent Skills](https://agentskills.io/specification), [Claude Code skills](https://code.claude.com/docs/en/skills) and [sub-agents](https://code.claude.com/docs/en/sub-agents), [Codex skills](https://developers.openai.com/codex/skills) and subagents. No upstream text is vendored, so there are no attribution obligations beyond crediting ideas here.

## Later skills on the same shape

experience-audit, implementer and growth-strategy reuse this layout: agent-neutral `SKILL.md` and `core/`, a role registry with tiers, generated host agents, a zero-dependency helper that owns state and gates, and a copied (not shared) run-log module so each installs alone.

growth-strategy (`skills/growth-strategy/`, design: [spec](superpowers/specs/2026-11-18-growth-strategy-design.md)) adds:
- JSON records where data is filtered or exported (`.growth/sources.json`, `keywords.json`, `items.json`) validated by `core/schemas/records.schema.json` plus semantic rules in `core/scripts/lib/evidence.mjs`: every metric value has a provenance (`measured` only from imported Search Console or analytics exports, `estimate` only from tool exports or the user, otherwise `unknown` and null).
- Two gates in code: an approved, hash-checked baseline before any phase can close, and decisions bound to an independent review of the current plan hash.
- Read-only integration contracts with product-intelligence and experience-audit, handoff files for the implementer written once so its close-out is kept, and no automation of publishing, posting or submissions.

## Extending

New skills go in `skills/<name>/` with the same shape (SKILL.md, references, templates, optional core/adapters). Share *conventions*, not code: copy small helpers rather than introducing a shared package that breaks single-skill installs. See [development.md](development.md).
