# Contributing

Thanks for helping. Each skill in `skills/` must be **independently installable**: everything it needs lives inside its own folder.

## Ground rules

1. **Spec first.** `SKILL.md` follows the [Agent Skills specification](https://agentskills.io/specification): `name` equals the folder name (lowercase, hyphens), `description` ≤ 1024 characters saying what it does *and when to use it*. Keep `SKILL.md` under 500 lines; push detail to `references/`.
2. **Agent-neutral core.** Methodology, templates, schemas, roles and validators must not mention a specific host (tool names, slash syntax, install paths). Host-specific material belongs in `adapters/<agent>/` or in `agents/openai.yaml`. The validator enforces this.
3. **No hardcoded model names** in the methodology. Use tiers (`reasoning`, `standard`, `fast`) and map them in config.
4. **No unverifiable claims.** Documentation about third-party tools must come from official docs; say "verify" where behaviour is uncertain.
5. **Zero runtime dependencies** unless justified in the PR. Helpers are plain Node 20+ ESM (repo tooling and tests need Node 22+).
6. **Gates are code, not prose.** Anything that must not depend on model discipline (approvals, lifecycle, scoring) is enforced by a script and covered by a test.
7. **Respect upstream licenses.** Borrowing an idea is fine; copying text from other projects needs a compatible license and attribution (see `docs/architecture.md`, "Prior art").

## Workflow

```bash
npm run validate   # skill structure, references, adapters, portability
npm test           # unit + scenario + failure-scenario tests
```

If you change `core/roles/roles.json`, `core/config.default.json` tiers or the agent templates, regenerate the adapter files:

```bash
npm run agents:generate
```

Add or update a test for every behaviour change. Update `CHANGELOG.md`. See [docs/development.md](docs/development.md) for adding a new skill.

## Reporting issues

Include: agent and version, install method, the command you ran, and `pi validate` output if artifacts are involved. Never paste secrets or private source code.
