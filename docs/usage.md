# Usage

## The workflow

```
init ──► [Gate 1: you approve PRODUCT.md] ──► research ──► opportunities ──► [Gate 2: you decide] ──► handoff ──► specs
                                                   ▲                                                       │
                                                   └──────────────── refresh (later runs) ◄────────────────┘
```

State lives in `.product/` in your project. Every run starts with `pi status`, so you can resume after any gate.

## Invocation

| Command | Claude Code | Codex | Plain language |
|---|---|---|---|
| status / continue | `/product-intelligence` | `$product-intelligence` | "continue product intelligence" |
| init | `/product-intelligence init` | `$product-intelligence init` | "understand this product" |
| research | `/product-intelligence research` | `$product-intelligence research` | "who are our competitors?" |
| opportunities | `/product-intelligence opportunities` | `$product-intelligence opportunities` | "what should we build next?" |
| feature | `/product-intelligence feature SSO login` | `$product-intelligence feature SSO login` | "should we add SSO?" |
| refresh | `/product-intelligence refresh` | `$product-intelligence refresh` | "what changed in the market?" |
| handoff | `/product-intelligence handoff` | `$product-intelligence handoff` | "write specs for the approved features" |
| full | `/product-intelligence full` | `$product-intelligence full` | "run the full product intelligence workflow" |

Codex does not substitute arguments into skills; the text after the skill name is part of your prompt and the skill routes on its first word.

## A typical session

1. `init` — the agent reads the repository (read-only), writes `.product/PRODUCT.md` as a **draft**, and asks you to confirm or correct it. Tell it what is wrong. When you say it is right, it records your approval.
2. `research` — competitor, open-source, emerging and adjacent research with cited sources, condensed into `.product/opportunities.md`.
3. `opportunities` — scored, independently reviewed shortlist. For each item answer: approve, reject, defer, research more, or modify. The agent records exactly what you decided.
4. `handoff` — a specification per approved opportunity in `.product/features/`. Give it to your implementation agent; this skill never implements.
5. Later: `refresh` — only what changed since last time.

## Artifacts

| File | Purpose |
|---|---|
| `.product/PRODUCT.md` | Approved product baseline. Hash-protected; revision history appended. |
| `.product/opportunities.md` | Market landscape, opportunity registry, decision log, details. Rejected/deferred ideas stay so they are not re-proposed. |
| `.product/features/FEATURE-NNN.md` | Implementation-ready spec (19 sections), only for approved opportunities. |
| `.product/config.json` | Optional overrides. |

Evidence tags look like `[E: fact; high; https://…; 2026-11-16]` ([evidence standards](../skills/product-intelligence/references/evidence-standards.md)). Lifecycle: Discovered → Under Evaluation → Proposed → Approved / Rejected / Deferred → Ready for Implementation → Implemented → Validated.

## Helper CLI

`node <skill-dir>/core/scripts/pi.mjs <command> [--dir <project>]` — the agent runs these for you, but you can too.

`status` · `validate` · `config` · `score --ratings … --confidence …` · `approve-product --by NAME` · `reopen-product --by NAME` · `confirm-product --by NAME` (re-check an unchanged baseline without a new revision) · `decide OPP-001 approve|reject|defer|research|modify --by NAME --note …` · `transition` · `new-feature OPP-001` · `snapshot` / `verify-clean`.

Approvals and decisions are recorded with your name and date, and only after you state them in chat. The Decision Log is hash-chained (each row's seal covers the previous one), the approved `PRODUCT.md` is hashed, and `pi validate` fails when a decided status disagrees with the log, a log row was edited, or the approved baseline changed.

**What this does and does not guarantee.** It is *tamper-evident*, not *tamper-proof*. An agent with file-write access and a shell can still run `pi decide --by "<your name>"` or recompute seals by hand, because nothing in a text file or a CLI can prove who typed a command. The real gate is you: the skill is instructed to run these commands only after you decide in chat, and you can check the Decision Log and `git diff .product/` at any time. If you want a stronger barrier, run `pi decide` / `pi approve-product` yourself in your own terminal and tell the agent the result, and use a permission mode that prompts before shell commands. Two built-in hardenings:

- **`gates.human_confirmation: "tty"`** in `.product/config.json`: `decide`, `approve-product`, `reopen-product` and `confirm-product` then refuse unless a person types `yes` in an interactive terminal. An agent's shell has no terminal, so you run those commands yourself. This is a speed bump, not a security boundary: an agent that can spawn a pseudo-terminal could answer the prompt, so keep permission prompts on as well.
- **Permission rules**: have your agent ask before running them. Claude Code example (`.claude/settings.json`): `{"permissions": {"ask": ["Bash(node *pi.mjs decide*)", "Bash(node *pi.mjs approve-product*)", "Bash(node *pi.mjs reopen-product*)", "Bash(node *pi.mjs confirm-product*)"]}}`. In Codex use an approval policy that prompts for these commands.

Also enforced: each decision seals a digest of the idea as the user saw it (title, scores, detail block), so an approved idea cannot be rewritten into another; `decide` refuses to append to a log that fails its integrity check; decisions and proposals need an approved, unmodified PRODUCT.md; approval metadata must agree with the Revision History; and the Decision Log's row count and head seal are kept in the frontmatter, so deleting rows from the end is detected. Reversing an approval is a user decision (`decide OPP-001 reject|defer|research`): the linked spec is marked `superseded` and revived as a draft if the item is approved again.

## Configuration

Create `.product/config.json` only for what you change; omitted keys use `core/config.default.json`.

```json
{
  "scoring": {
    "criteria": { "user_value": 0.3, "strategic_alignment": 0.2, "market_opportunity": 0.1,
                  "competitive_differentiation": 0.1, "business_impact": 0.2, "implementation_feasibility": 0.1 },
    "tiers": { "recommend_min": 75, "consider_min": 55 }
  },
  "freshness": { "source_max_age_days": 120, "market_refresh_days": 14 },
  "models": {
    "claude-code": { "reasoning": "opus", "standard": "sonnet", "fast": "haiku" },
    "codex": { "reasoning": null, "standard": null, "fast": null },
    "role_tier_overrides": { "market-researcher": "fast" }
  }
}
```

- Weights are normalized (they need not sum to 1). Criteria names are yours; ratings use the same names.
- Roles use tiers; tiers map to models per agent. `null` means "inherit the session model". After editing models, re-run `install-agents.mjs`.
- Schema: `core/schemas/config.schema.json`; `pi validate` reports invalid config.

## Limitations (read these)

- **No background monitoring.** Freshness is checked only when you invoke the skill. For scheduled refreshes use your agent's scheduler to invoke `refresh` yourself; the skill does not claim otherwise.
- Research quality depends on web access, the model, and the sources reachable without sign-in. Paywalled data, private communities and internal metrics are out of reach; the skill records them as unknown.
- The automated tests verify contracts (gates, evidence rules, validators), not the LLM's judgement. Live-run rubrics are in `tests/scenarios/`.
- Independent review needs a second agent. Without one the skill says `self-review` and why.
- Read-only behaviour for sub-agents: Claude Code agents get read/search/web tool allow-lists, except the repository analyst, which keeps `Bash` for inventory and is read-only by instruction only; elsewhere it is instructions. The post-run `verify-clean` check is the backstop everywhere. Run research in a clean working tree for the clearest signal.
- The validator checks structure, not truth: a well-formed tag can still cite a weak source. Review the evidence for decisions that matter.
