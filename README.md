# agent-skills

Reusable, independently installable skills for AI coding agents. They follow the open [Agent Skills](https://agentskills.io) format, so they work in **Claude Code**, **OpenAI Codex**, and other hosts that read `SKILL.md`.

| Skill | What it does | Version |
|---|---|---|
| [`product-intelligence`](skills/product-intelligence/SKILL.md) | Understands your product, researches the market with cited evidence, finds and prioritizes opportunities, and writes implementation-ready feature specs, with human approval at every decision | 0.1.0 |

## Product Intelligence

**Why it exists.** Agents are good at building and bad at deciding *what* to build: they invent requirements, repeat competitor features without a user problem, and mix guesses with facts. Product Intelligence is a read-only product-strategy workflow with hard approval gates and an evidence standard, ending in specs an implementation agent can consume without inventing requirements.

**What it does**

1. **Understand** (`init`): inspects your repository (read-only), separates observed facts from inferences, assumptions and unknowns, drafts `.product/PRODUCT.md`, and waits for *your* approval.
2. **Research** (`research`): direct, indirect, open-source, emerging and adjacent competitors with source URL, access date, confidence and fact/inference/hypothesis labels. Stars are never treated as traction.
3. **Find and prioritize** (`opportunities`): connects each opportunity to a real user problem and business objective, scores it with a configurable weighted rubric, and caps the tier when evidence is weak.
4. **Review**: an independent reviewer sub-agent challenges the findings (or the run says plainly that it could not).
5. **Decide**: you approve, reject, defer, request research or modify, each recorded in a decision log.
6. **Specify** (`handoff`): 19-section specs with testable Given/When/Then criteria, only for approved opportunities.

It never edits application code, implements features, opens application PRs or deploys.

**Architecture** — agent-neutral core (method, schemas, validators, role definitions, helper CLI) + thin adapters (Claude Code, Codex). Approval gates, lifecycle, scoring and source protection are checked by a zero-dependency Node helper and validator, not just by instructions. The gates are tamper-evident rather than tamper-proof: an agent with a shell can still run the commands, so the real gate is you (see [usage](docs/usage.md#helper-cli)) Details: [docs/architecture.md](docs/architecture.md).

## Install (only this skill)

```bash
# Claude Code and Codex, current project
npx skills add sourav-ojha/agent-skills --skill product-intelligence -a claude-code -a codex
# personal (all projects): add -g
```

Manual copy, release archive, optional native sub-agents, upgrade and removal: [docs/installation.md](docs/installation.md). Replace `sourav-ojha/agent-skills` with wherever you publish this repository.

## Use

```
Claude Code:  /product-intelligence init
Codex:        $product-intelligence init
Plain text:   "Understand this product and tell me who our competitors are"
```

Commands: `init` · `research` · `opportunities` · `feature <idea>` · `refresh` · `handoff` · `full`. Walkthrough, artifacts, configuration and limitations: [docs/usage.md](docs/usage.md).

Output in your project:

```
.product/
├── PRODUCT.md           approved baseline (hash-protected, revision history)
├── opportunities.md     market landscape, registry, decision log
└── features/FEATURE-001.md
```

## Configuration

Optional `.product/config.json`: scoring weights and thresholds, source freshness windows, and model tiers per agent. Nothing is hardcoded to a model. See [docs/usage.md](docs/usage.md#configuration).

## Limitations

No background monitoring (freshness is checked when you invoke it); research is limited to what the agent can reach publicly; independent review needs a second agent; automated tests prove the artifact and gate contracts, not the model's judgement (live-run rubrics are in `tests/scenarios/`). Full list in [docs/usage.md](docs/usage.md#limitations-read-these).

## Validation

```bash
npm run check    # repo validator + test suite (Node 22+, no dependencies)
```

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md). MIT licensed, see [LICENSE](LICENSE). Prior art and attribution: [docs/architecture.md](docs/architecture.md#prior-art-researched-2026-11-16-ideas-only-no-text-or-code-copied).
